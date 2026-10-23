import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INGEST_TYPES } from './events/schema.js';
import { startTestBus, type TestBus } from './test-helpers.js';

let bus: TestBus;
beforeEach(async () => {
  bus = await startTestBus();
});
afterEach(async () => {
  await bus.close();
});

const progress = (extra: Record<string, unknown> = {}) => ({
  type: 'progress',
  source: 'apm-hub/hook',
  agentId: null,
  issue: 43,
  runId: null,
  data: { line: 'built', agent: 'orchestrator' },
  ...extra,
});

function post(body: unknown, raw = false): Promise<Response> {
  return fetch(`${bus.http.url}/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw ? (body as string) : JSON.stringify(body),
  });
}

describe('POST /ingest', () => {
  it('broadcasts nothing when a batch fails mid-transaction', async () => {
    const seen: string[] = [];
    bus.events.onEvent((e) => seen.push(e.kind));
    const real = bus.db.insertEvent.bind(bus.db);
    let calls = 0;
    const spy = vi.spyOn(bus.db, 'insertEvent').mockImplementation((...args) => {
      calls += 1;
      if (calls === 2) {
        throw new Error('disk full');
      }
      return real(...args);
    });
    const res = await post([progress(), progress()]);
    spy.mockRestore();
    await new Promise((r) => setImmediate(r));
    expect(res.status).toBe(500);
    expect(bus.db.listEvents()).toHaveLength(0);
    expect(seen).toEqual([]);
  });

  it('accepts one event with 202 and stores it', async () => {
    const res = await post(progress());
    expect(res.status).toBe(202);
    const { ids } = (await res.json()) as { ids: number[] };
    const rows = bus.db.listEvents();
    expect(rows).toHaveLength(1);
    expect(ids).toEqual([rows[0]?.id]);
    expect(rows[0]?.kind).toBe('progress');
    expect(rows[0]?.role).toBe('apm-hub/hook');
  });

  it('accepts an array in order', async () => {
    const res = await post([
      progress(),
      { ...progress(), type: 'agent.state', data: { state: 'busy' } },
      progress({ issue: 44 }),
    ]);
    expect(res.status).toBe(202);
    expect(bus.db.listEvents().map((r) => r.kind)).toEqual(['progress', 'agent.state', 'progress']);
  });

  it('accepts agent.run and rejects depth 0 with 400', async () => {
    const data = {
      state: 'started',
      runAgentId: 'a1',
      parentAgentId: null,
      toolUseId: null,
      agentType: 'implementer',
      description: null,
      depth: 1,
      model: null,
      durationMs: null,
      summary: null,
    };
    const run = { ...progress(), type: 'agent.run', data };
    expect((await post(run)).status).toBe(202);
    expect(bus.db.listEvents().map((r) => r.kind)).toEqual(['agent.run']);
    const bad = await post({ ...run, data: { ...data, depth: 0 } });
    expect(bad.status).toBe(400);
    expect(bus.db.listEvents()).toHaveLength(1);
  });

  it('broadcasts to subscribers', async () => {
    const seen: string[] = [];
    bus.events.onEvent((e) => seen.push(e.kind));
    await post(progress());
    await new Promise((r) => setImmediate(r));
    expect(seen).toEqual(['progress']);
  });

  it('rejects a disallowed type with 403 and stores nothing', async () => {
    const res = await post({ ...progress(), type: 'run.state' });
    expect(res.status).toBe(403);
    expect(bus.db.listEvents()).toHaveLength(0);
  });

  it('rejects a mixed batch as a whole with 403', async () => {
    const res = await post([progress(), { ...progress(), type: 'hook:idle' }]);
    expect(res.status).toBe(403);
    expect(bus.db.listEvents()).toHaveLength(0);
  });

  it('rejects a batch with one invalid item with 400 and stores nothing', async () => {
    const { source: _s, ...noSource } = progress();
    const res = await post([progress(), noSource]);
    expect(res.status).toBe(400);
    expect(bus.db.listEvents()).toHaveLength(0);
  });

  it('requires source', async () => {
    const { source: _s, ...noSource } = progress();
    expect((await post(noSource)).status).toBe(400);
  });

  it('rejects invalid JSON, empty batch and non-objects with 400', async () => {
    expect((await post('{nope', true)).status).toBe(400);
    expect((await post([])).status).toBe(400);
    expect((await post(['x'])).status).toBe(400);
  });

  it('answers non-POST with 405', async () => {
    const res = await fetch(`${bus.http.url}/ingest`);
    expect(res.status).toBe(405);
  });

  it('overrides client-supplied id and at', async () => {
    const stream: number[] = [];
    bus.events.onEvent((e) => stream.push(e.id));
    const res = await post(progress({ id: 999999, at: '2000-01-01T00:00:00.000Z' }));
    expect(res.status).toBe(202);
    await new Promise((r) => setImmediate(r));
    const row = bus.db.listEvents()[0];
    expect(row?.id).not.toBe(999999);
    expect(row?.createdAt).not.toContain('2000-01-01');
    expect(stream).toEqual([row?.id]);
  });

  it('exposes the allowlist', () => {
    expect([...INGEST_TYPES]).toEqual([
      'progress',
      'attention',
      'usage',
      'queue.item',
      'agent.state',
      'agent.run',
    ]);
  });
});
