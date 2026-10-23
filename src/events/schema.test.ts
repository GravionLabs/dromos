import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildEventsSchema, EVENTS_SCHEMA_PATH, serializeEventsSchema } from './export-schema.js';
import { BUS_EVENT_TYPES, BusEventSchema } from './schema.js';

const fixturesDir = fileURLToPath(new URL('../../schema/fixtures/', import.meta.url));
const fixtureFiles = readdirSync(fixturesDir).filter((f) => f.endsWith('.json'));
const readFixture = (f: string): Record<string, unknown> =>
  JSON.parse(readFileSync(fixturesDir + f, 'utf8'));

describe('BusEventSchema fixtures', () => {
  it.each(fixtureFiles)('%s parses', (f) => {
    expect(BusEventSchema.safeParse(readFixture(f)).success).toBe(true);
  });

  it('has exactly one fixture per event type', () => {
    expect([...fixtureFiles].sort()).toEqual(
      BUS_EVENT_TYPES.map((t) => `${t.replace(/[:.]/g, '-')}.json`).sort(),
    );
    const types = fixtureFiles.map((f) => readFixture(f).type);
    expect([...types].sort()).toEqual([...BUS_EVENT_TYPES].sort());
  });
});

describe('BusEventSchema validation', () => {
  const valid = () => readFixture('hook-idle.json');

  it('rejects an unknown type', () => {
    expect(BusEventSchema.safeParse({ ...valid(), type: 'hook:unknown' }).success).toBe(false);
  });

  it('rejects a non-ISO timestamp', () => {
    expect(BusEventSchema.safeParse({ ...valid(), at: 'yesterday' }).success).toBe(false);
  });

  it('rejects a non-integer id', () => {
    expect(BusEventSchema.safeParse({ ...valid(), id: 1.5 }).success).toBe(false);
  });

  const withSource = (source: string) => BusEventSchema.safeParse({ ...valid(), source }).success;

  it('accepts a free-form source identifier', () => {
    expect(withSource('apm-hub/subagent-stop')).toBe(true);
    expect(withSource('implementer')).toBe(true);
    expect(withSource('a'.repeat(128))).toBe(true);
  });

  it('rejects an empty, malformed or oversized source', () => {
    for (const source of ['', 'Apm Hub', '1abc', 'a'.repeat(129)]) {
      expect(withSource(source), source).toBe(false);
    }
  });

  it('rejects a missing nullable envelope field', () => {
    const { runId: _runId, ...rest } = valid();
    expect(BusEventSchema.safeParse(rest).success).toBe(false);
  });

  // Strictness parity with the generated Rust types (crates/dromos-mux-proto/tests/fixtures.rs).
  it('rejects an unknown envelope field', () => {
    expect(BusEventSchema.safeParse({ ...valid(), extra: true }).success).toBe(false);
  });

  it('rejects an unknown data field', () => {
    const data = { ...(valid().data as object), extra: true };
    expect(BusEventSchema.safeParse({ ...valid(), data }).success).toBe(false);
  });

  it('rejects a timestamp with a UTC offset instead of Z', () => {
    expect(BusEventSchema.safeParse({ ...valid(), at: '2026-10-22T09:15:30+02:00' }).success).toBe(
      false,
    );
  });

  it('rejects an impossible date', () => {
    expect(BusEventSchema.safeParse({ ...valid(), at: '2026-02-29T00:00:00Z' }).success).toBe(
      false,
    );
  });

  it('accepts a leap day in a leap year', () => {
    expect(BusEventSchema.safeParse({ ...valid(), at: '2028-02-29T00:00:00Z' }).success).toBe(true);
  });

  it('rejects an empty model', () => {
    const data = { ...(valid().data as object), model: '' };
    expect(BusEventSchema.safeParse({ ...valid(), data }).success).toBe(false);
  });

  it('rejects an id outside the safe integer range', () => {
    expect(BusEventSchema.safeParse({ ...valid(), id: 2 ** 53 }).success).toBe(false);
  });

  it('rejects data that is not a hook event', () => {
    expect(BusEventSchema.safeParse({ ...valid(), data: { state: 'idle' } }).success).toBe(false);
  });
});

describe('external event types', () => {
  /** Parses the named fixture with `patch` applied; the fixture itself stays untouched. */
  const accepts = (f: string, patch: (e: Record<string, unknown>) => void) => {
    const e = readFixture(f);
    patch(e);
    return BusEventSchema.safeParse(e).success;
  };
  const withData = (f: string, extra: Record<string, unknown>) =>
    accepts(f, (e) => {
      e.data = { ...(e.data as object), ...extra };
    });
  const withoutData = (f: string, key: string) =>
    accepts(f, (e) => {
      const { [key]: _drop, ...rest } = e.data as Record<string, unknown>;
      e.data = rest;
    });

  it('accepts a non-role source with a null agentId on progress', () => {
    expect(
      accepts('progress.json', (e) => {
        e.source = 'apm-hub/other';
        e.agentId = null;
      }),
    ).toBe(true);
  });

  it('rejects an extra progress data key and a missing or null agent', () => {
    expect(withData('progress.json', { extra: 1 })).toBe(false);
    expect(withoutData('progress.json', 'agent')).toBe(false);
    expect(withData('progress.json', { agent: null })).toBe(false);
  });

  it('bounds progress line and agent', () => {
    expect(withData('progress.json', { line: '' })).toBe(false);
    expect(withData('progress.json', { line: 'x'.repeat(1000) })).toBe(true);
    expect(withData('progress.json', { line: 'x'.repeat(1001) })).toBe(false);
    expect(withData('progress.json', { agent: 'x'.repeat(65) })).toBe(false);
  });

  it('rejects control characters and ANSI escapes in free text', () => {
    expect(withData('progress.json', { line: 'a\u001b[31mred' })).toBe(false);
    expect(withData('attention.json', { summary: 'two\nlines' })).toBe(false);
    expect(withData('usage.json', { model: 'm\u0007' })).toBe(false);
    expect(withData('queue-item.json', { mode: 'a\tb' })).toBe(false);
    expect(
      accepts('progress.json', (e) => {
        e.runId = 'run\u0000';
      }),
    ).toBe(false);
  });

  it('caps agentId and runId at 128 characters and rejects empty ones', () => {
    expect(
      accepts('progress.json', (e) => {
        e.agentId = 'x'.repeat(128);
      }),
    ).toBe(true);
    expect(
      accepts('progress.json', (e) => {
        e.agentId = 'x'.repeat(129);
      }),
    ).toBe(false);
    expect(
      accepts('progress.json', (e) => {
        e.runId = '';
      }),
    ).toBe(false);
  });

  it('accepts every attention kind and rejects others', () => {
    for (const kind of ['GATE', 'BLOCKED', 'FAILED', 'QUESTION']) {
      expect(withData('attention.json', { kind }), kind).toBe(true);
    }
    expect(withData('attention.json', { kind: 'DONE' })).toBe(false);
  });

  it('bounds attention summary and pr', () => {
    expect(withData('attention.json', { pr: null })).toBe(true);
    expect(withData('attention.json', { pr: 1.5 })).toBe(false);
    expect(withoutData('attention.json', 'pr')).toBe(false);
    expect(withData('attention.json', { summary: '' })).toBe(false);
    expect(withData('attention.json', { summary: 'x'.repeat(2000) })).toBe(true);
    expect(withData('attention.json', { summary: 'x'.repeat(2001) })).toBe(false);
  });

  it('validates usage bounds', () => {
    expect(withData('usage.json', { costUsd: null, model: null })).toBe(true);
    expect(withData('usage.json', { contextTokens: 0, costUsd: 0 })).toBe(true);
    expect(withData('usage.json', { contextTokens: -1 })).toBe(false);
    expect(withData('usage.json', { costUsd: -0.01 })).toBe(false);
    expect(withData('usage.json', { model: 'x'.repeat(129) })).toBe(false);
    expect(withoutData('usage.json', 'costUsd')).toBe(false);
  });

  it('validates queue.item state, exit code range and mode', () => {
    expect(withData('queue-item.json', { exitCode: 3 })).toBe(true);
    expect(withData('queue-item.json', { exitCode: 4 })).toBe(false);
    expect(withData('queue-item.json', { exitCode: -1 })).toBe(false);
    expect(withData('queue-item.json', { state: 'running' })).toBe(false);
    expect(withData('queue-item.json', { durationMs: -1 })).toBe(false);
    expect(withData('queue-item.json', { mode: 'x'.repeat(65) })).toBe(false);
    expect(withoutData('queue-item.json', 'mode')).toBe(false);
  });

  it('couples queue.item state with exitCode and durationMs', () => {
    const started = { state: 'started', exitCode: null, durationMs: null };
    expect(withData('queue-item.json', started)).toBe(true);
    expect(withData('queue-item.json', { ...started, exitCode: 0 })).toBe(false);
    expect(withData('queue-item.json', { ...started, durationMs: 5 })).toBe(false);
    expect(withData('queue-item.json', { exitCode: null })).toBe(false);
    expect(withData('queue-item.json', { durationMs: null })).toBe(true);
  });
});

describe('Rust parity cases (schema/parity.json)', () => {
  type Case = { name: string; fixture: string; valid: boolean; set?: Record<string, unknown> };
  const cases: Case[] = JSON.parse(
    readFileSync(fileURLToPath(new URL('../../schema/parity.json', import.meta.url)), 'utf8'),
  ).cases;
  const expand = (v: unknown) => {
    const r = (v as { repeat?: unknown } | null)?.repeat;
    return Array.isArray(r) ? (r[0] as string).repeat(r[1] as number) : v;
  };
  const setPath = (obj: Record<string, unknown>, path: string, value: unknown) => {
    const parts = path.split('.');
    const last = parts.pop() as string;
    let node = obj;
    for (const p of parts) node = node[p] as Record<string, unknown>;
    node[last] = value;
  };

  it('has the cases', () => {
    expect(cases.length).toBeGreaterThan(100);
  });

  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const event = readFixture(c.fixture);
    for (const [path, value] of Object.entries(c.set ?? {})) setPath(event, path, expand(value));
    expect(BusEventSchema.safeParse(event).success).toBe(c.valid);
  });

  it('counts length in code points like Rust, not UTF-16 units', () => {
    const line = (n: number) => {
      const e = readFixture('progress.json');
      e.data = { ...(e.data as object), line: '\u{1F600}'.repeat(n) };
      return BusEventSchema.safeParse(e).success;
    };
    expect(line(1000)).toBe(true);
    expect(line(1001)).toBe(false);
  });
});

describe('events JSON Schema', () => {
  it('exposes BusEvent as a oneOf of the named variants', () => {
    const schema = buildEventsSchema() as {
      definitions: { BusEvent: { oneOf: { $ref: string }[] } };
    };
    expect(schema.definitions.BusEvent.oneOf.map((v) => v.$ref)).toEqual([
      '#/definitions/HookIdleEvent',
      '#/definitions/HookBusyEvent',
      '#/definitions/ProgressEvent',
      '#/definitions/AttentionEvent',
      '#/definitions/UsageEvent',
      '#/definitions/QueueItemEvent',
      '#/definitions/AgentRegisteredEvent',
      '#/definitions/AgentStateEvent',
    ]);
  });

  it('matches the committed schema/events.schema.json (drift guard)', () => {
    expect(serializeEventsSchema()).toBe(readFileSync(EVENTS_SCHEMA_PATH, 'utf8'));
  });
});
