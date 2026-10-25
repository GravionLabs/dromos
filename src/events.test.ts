import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
      expect(bus.readLog()).toMatch(/ERROR +rejected hook implementer busy/);
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

  it('answers 500 and stores nothing when the agent state update fails, so a retry cannot duplicate', async () => {
    await bus.connect('implementer', 'impl-1');
    vi.spyOn(bus.db, 'updateAgentState').mockImplementation(() => {
      throw new Error('db down');
    });
    const before = bus.db.listEvents().length;
    const res = await post('{"role":"implementer","cli":"claude","state":"busy"}');
    expect(res.status).toBe(500);
    expect(bus.db.listEvents().length).toBe(before);
    expect(bus.readLog()).toMatch(/ERROR +hook implementer busy: Error: db down/);
    vi.restoreAllMocks();
  });

  it('stores agent.state first, then the hook row, both ordered by id', async () => {
    await bus.connect('implementer', 'impl-1');
    const from = bus.db.listEventsSince(0).length;
    await post('{"role":"implementer","cli":"claude","state":"busy"}');
    const added = bus.db.listEventsSince(0).slice(from);
    expect(added.map((e) => e.kind)).toEqual(['agent.state', 'hook:busy']);
  });

  it('stores a hook row with the resolved agent id, or null when none resolves', async () => {
    await post('{"role":"reviewer","cli":"claude","state":"busy"}');
    const none = bus.db.listEventsSince(0).filter((e) => e.kind === 'hook:busy');
    expect(none.map((e) => e.agentId)).toEqual([null]);
    await bus.connect('implementer', 'impl-1');
    await post('{"role":"implementer","cli":"claude","state":"busy"}');
    const hooks = bus.db.listEventsSince(0).filter((e) => e.kind === 'hook:busy');
    expect(hooks.map((e) => e.agentId)).toEqual([null, 'impl-1']);
  });

  it('when a subscriber throws on agent.state: 500, no hook row, and a retry stores it once', async () => {
    await bus.connect('implementer', 'impl-1');
    let fail = true;
    bus.events.onEvent((e) => {
      if (fail && e.kind === 'agent.state') throw new Error('boom');
    });
    const body = '{"role":"implementer","cli":"claude","state":"busy"}';
    expect((await post(body)).status).toBe(500);
    expect(bus.db.getAgent('impl-1')?.state).toBe('busy');
    expect(bus.db.listEventsSince(0).filter((e) => e.kind === 'hook:busy')).toHaveLength(0);
    fail = false;
    expect((await post(body)).status).toBe(204);
    expect(bus.db.listEventsSince(0).filter((e) => e.kind === 'hook:busy')).toHaveLength(1);
  });

  it('when a subscriber throws on the hook event: 500, state changed, hook row stored', async () => {
    await bus.connect('implementer', 'impl-1');
    bus.events.onEvent((e) => {
      if (e.kind === 'hook:busy') throw new Error('boom');
    });
    const res = await post('{"role":"implementer","cli":"claude","state":"busy"}');
    expect(res.status).toBe(500);
    expect(bus.db.getAgent('impl-1')?.state).toBe('busy');
    expect(bus.db.listEventsSince(0).filter((e) => e.kind === 'hook:busy')).toHaveLength(1);
    expect(bus.readLog()).toMatch(/ERROR +hook implementer busy: Error: boom/);
  });

  it('answers a rejected hook with a one-line error, not the full report', async () => {
    const res = await post(
      JSON.stringify({ role: 'implementer', cli: 'claude', state: 'busy', model: 'a\u0007b' }),
    );
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: string };
    expect(error).toMatch(/^[^\n]+$/);
    expect(error).toContain('model');
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
