import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventValidationError, recordEvent } from './event-store.js';
import { startTestBus, type TestBus } from './test-helpers.js';

const valid = {
  id: 0,
  type: 'progress',
  at: '2026-01-01T00:00:00.000Z',
  source: 'orchestrator',
  agentId: null,
  issue: 42,
  runId: null,
  data: { line: 'step done', agent: 'implementer' },
};

describe('recordEvent', () => {
  let bus: TestBus;
  const seen: number[] = [];

  beforeEach(async () => {
    bus = await startTestBus();
    seen.length = 0;
    bus.events.onEvent((e) => seen.push(e.id));
  });

  afterEach(async () => {
    await bus.close();
  });

  it('stores and broadcasts a valid event with kind = type', () => {
    const row = recordEvent(bus.db, bus.events, 'orchestrator', valid);
    expect(row).toMatchObject({
      role: 'orchestrator',
      kind: 'progress',
      data: { line: 'step done', agent: 'implementer' },
    });
    expect(bus.db.listEventsSince(0)).toHaveLength(1);
    expect(seen).toEqual([row.id]);
  });

  it.each([
    ['unknown type', { ...valid, type: 'nope' }],
    ['wrong data shape', { ...valid, data: { line: '' } }],
    ['missing envelope field', { ...valid, at: undefined }],
    ['unknown envelope key', { ...valid, extra: 1 }],
    ['not an object', 'text'],
  ])('rejects %s without storing or broadcasting', (_name, event) => {
    expect(() => recordEvent(bus.db, bus.events, 'orchestrator', event)).toThrow(
      EventValidationError,
    );
    expect(bus.db.listEventsSince(0)).toEqual([]);
    expect(seen).toEqual([]);
  });

  it('carries a readable validation message', () => {
    try {
      recordEvent(bus.db, bus.events, 'orchestrator', { ...valid, data: { line: '' } });
      expect.unreachable();
    } catch (error) {
      expect((error as EventValidationError).detail).toContain('line');
    }
  });
});
