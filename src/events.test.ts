import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTestBus, type TestBus } from './test-helpers.js';

describe('POST /events', () => {
  let bus: TestBus;

  beforeEach(async () => {
    bus = await startTestBus();
  });

  afterEach(async () => {
    await bus.close();
  });

  const post = (body: string) =>
    fetch(`${bus.http.url}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });

  it('stores a valid hook event, answers 204 and logs a HOOK line', async () => {
    const res = await post('{"role":"implementer","cli":"claude","state":"idle"}');
    expect(res.status).toBe(204);
    expect(bus.db.listEvents('implementer')).toMatchObject([
      { role: 'implementer', kind: 'hook:idle', data: { cli: 'claude', state: 'idle' } },
    ]);
    expect(bus.readLog()).toMatch(/ HOOK {9}implementer idle \(claude\)\n$/);
  });

  it('broadcasts exactly one event whose id equals the stored row id', async () => {
    const seen: { id: number; kind: string }[] = [];
    bus.events.onEvent((e) => seen.push({ id: e.id, kind: e.kind }));
    await post('{"role":"implementer","cli":"claude","state":"idle"}');
    const stored = bus.db.listEvents('implementer');
    expect(stored).toHaveLength(1);
    expect(seen).toEqual([{ id: stored[0]?.id, kind: 'hook:idle' }]);
  });

  it('broadcasts nothing for an invalid event', async () => {
    const seen: number[] = [];
    bus.events.onEvent((e) => seen.push(e.id));
    await post('{"role":"implementer","cli":"claude","state":"sleeping"}');
    expect(seen).toEqual([]);
    expect(bus.db.listEvents()).toEqual([]);
  });

  it('rejects a hook event that fails BusEvent validation: 400, not stored, not broadcast', async () => {
    const seen: number[] = [];
    bus.events.onEvent((e) => seen.push(e.id));
    const res = await post(
      '{"role":"implementer","cli":"claude","state":"idle","model":"a\\u0007b"}',
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('model');
    expect(bus.db.listEventsSince(0)).toEqual([]);
    expect(seen).toEqual([]);
    expect(bus.readLog()).toBe('');
  });

  it('includes the model in the log line when given', async () => {
    await post('{"role":"reviewer","cli":"copilot","state":"busy","model":"GPT-Luna"}');
    expect(bus.readLog()).toContain('reviewer busy (copilot, GPT-Luna)');
  });

  it('rejects an invalid body with 400 and the field name', async () => {
    const res = await post('{"role":"implementer","cli":"claude","state":"sleeping"}');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('state');
    expect(bus.db.listEvents()).toEqual([]);
    expect(bus.readLog()).toBe('');
  });

  it('rejects malformed JSON with 400', async () => {
    expect((await post('{nope')).status).toBe(400);
  });

  it('rejects an empty body with 400', async () => {
    expect((await post('')).status).toBe(400);
  });

  it('rejects other methods with 405', async () => {
    expect((await fetch(`${bus.http.url}/events`)).status).toBe(405);
  });
});
