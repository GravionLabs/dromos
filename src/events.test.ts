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

  it('stores the posted hook data unchanged', async () => {
    const body = {
      role: 'implementer',
      cli: 'copilot',
      state: 'busy',
      model: 'GPT-Luna',
      sessionId: 'sess-1',
    };
    expect((await post(JSON.stringify(body))).status).toBe(204);
    expect(bus.db.listEvents('implementer')).toMatchObject([{ kind: 'hook:busy', data: body }]);
  });

  it.each([
    ['model with a control character', { model: 'a\u0007b' }],
    ['model with a bidi control', { model: 'a\u202eb' }],
    ['sessionId with a zero-width character', { sessionId: 'a\u200bb' }],
    ['sessionId with a newline', { sessionId: 'a\nb' }],
  ])(
    'rejects a hook event with a %s: 400, not stored, not broadcast, agent state unchanged',
    async (_name, extra) => {
      await bus.connect('implementer', 'impl-1');
      const seen: number[] = [];
      bus.events.onEvent((e) => seen.push(e.id));
      const before = bus.db.listEvents().length;
      const res = await post(
        JSON.stringify({ role: 'implementer', cli: 'claude', state: 'busy', ...extra }),
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/model|sessionId/);
      expect(bus.db.listEvents().length).toBe(before);
      expect(seen).toEqual([]);
      expect(bus.db.getAgent('impl-1')?.state).toBe('idle');
      expect(bus.readLog()).not.toContain('HOOK');
    },
  );

  it('answers 500 and logs an ERROR when a subscriber throws after the row is stored', async () => {
    bus.events.onEvent(() => {
      throw new Error('boom');
    });
    const res = await post('{"role":"implementer","cli":"claude","state":"idle"}');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal error' });
    expect(bus.db.listEvents('implementer')).toHaveLength(1);
    expect(bus.readLog()).toMatch(/ERROR +hook implementer idle: Error: boom/);
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
    expect(bus.readLog()).not.toContain('HOOK');
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
