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
      BUS_EVENT_TYPES.map((t) => `${t.replace(':', '-')}.json`).sort(),
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

  it('rejects an unknown source role', () => {
    expect(BusEventSchema.safeParse({ ...valid(), source: 'robot' }).success).toBe(false);
  });

  it('rejects a missing nullable envelope field', () => {
    const { runId: _runId, ...rest } = valid();
    expect(BusEventSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects data that is not a hook event', () => {
    expect(BusEventSchema.safeParse({ ...valid(), data: { state: 'idle' } }).success).toBe(false);
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
    ]);
  });

  it('matches the committed schema/events.schema.json (drift guard)', () => {
    expect(serializeEventsSchema()).toBe(readFileSync(EVENTS_SCHEMA_PATH, 'utf8'));
  });
});
