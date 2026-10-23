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
      BUS_EVENT_TYPES.map((t) => `${t.replace(/[:.]/, '-')}.json`).sort(),
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

  it('accepts a free-form source identifier', () => {
    const ok = (source: string) => BusEventSchema.safeParse({ ...valid(), source }).success;
    expect(ok('apm-hub/subagent-stop')).toBe(true);
    expect(ok('implementer')).toBe(true);
  });

  it('rejects an empty, malformed or oversized source', () => {
    const ok = (source: string) => BusEventSchema.safeParse({ ...valid(), source }).success;
    expect(ok('')).toBe(false);
    expect(ok('Apm Hub')).toBe(false);
    expect(ok('1abc')).toBe(false);
    expect(ok('a'.repeat(129))).toBe(false);
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
  const bad = (f: string, patch: (e: Record<string, unknown>) => void) => {
    const e = readFixture(f);
    patch(e);
    return BusEventSchema.safeParse(e).success;
  };
  const withData = (f: string, extra: Record<string, unknown>) =>
    bad(f, (e) => {
      e.data = { ...(e.data as object), ...extra };
    });

  it('progress fixture uses a non-role source and a null agentId', () => {
    const e = readFixture('progress.json');
    expect(e.source).toBe('apm-hub/subagent-stop');
    expect(e.agentId).toBeNull();
  });

  it('rejects an extra progress data key', () => {
    expect(withData('progress.json', { extra: 1 })).toBe(false);
  });

  it('rejects an empty or oversized progress line', () => {
    expect(withData('progress.json', { line: '' })).toBe(false);
    expect(withData('progress.json', { line: 'x'.repeat(1001) })).toBe(false);
  });

  it('accepts every attention kind and rejects others', () => {
    for (const kind of ['GATE', 'BLOCKED', 'FAILED', 'QUESTION']) {
      expect(withData('attention.json', { kind })).toBe(true);
    }
    expect(withData('attention.json', { kind: 'DONE' })).toBe(false);
  });

  it('accepts a null attention pr and rejects a fractional one', () => {
    expect(withData('attention.json', { pr: null })).toBe(true);
    expect(withData('attention.json', { pr: 1.5 })).toBe(false);
  });

  it('validates usage bounds', () => {
    expect(withData('usage.json', { costUsd: null, model: null })).toBe(true);
    expect(withData('usage.json', { contextTokens: 0 })).toBe(true);
    expect(withData('usage.json', { contextTokens: -1 })).toBe(false);
    expect(withData('usage.json', { costUsd: -0.01 })).toBe(false);
  });

  it('validates queue.item state and exit code range', () => {
    expect(
      withData('queue-item.json', { state: 'started', exitCode: null, durationMs: null }),
    ).toBe(true);
    expect(withData('queue-item.json', { exitCode: 3 })).toBe(true);
    expect(withData('queue-item.json', { exitCode: 4 })).toBe(false);
    expect(withData('queue-item.json', { exitCode: -1 })).toBe(false);
    expect(withData('queue-item.json', { state: 'running' })).toBe(false);
    expect(withData('queue-item.json', { durationMs: -1 })).toBe(false);
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
    ]);
  });

  it('matches the committed schema/events.schema.json (drift guard)', () => {
    expect(serializeEventsSchema()).toBe(readFileSync(EVENTS_SCHEMA_PATH, 'utf8'));
  });
});
