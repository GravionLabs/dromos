import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { EventPage } from './db.js';
import { recordEvent } from './event-store.js';
import { startTestBus, type TestBus } from './test-helpers.js';

let bus: TestBus;
beforeAll(async () => {
  bus = await startTestBus();
});
afterAll(async () => {
  await bus.close();
});
afterEach(() => {
  vi.useRealTimers();
});

const progress = (issue: number | null, agentId: string | null = null) => ({
  id: 0,
  at: '2030-01-01T00:00:00.000Z',
  source: 'test',
  type: 'progress',
  agentId,
  issue,
  runId: null,
  data: { line: 'built', agent: 'orchestrator' },
});
const get = (qs: string, init?: RequestInit) => fetch(`${bus.http.url}/events${qs}`, init);
async function page(qs: string): Promise<EventPage> {
  const res = await get(qs);
  expect(res.status).toBe(200);
  return (await res.json()) as EventPage;
}

describe('GET /events filters', () => {
  it('filters by issue and type exactly, and supports comma lists', async () => {
    const a = recordEvent(bus.db, bus.events, 'src-a', progress(9001));
    const b = recordEvent(bus.db, bus.events, 'src-b', progress(9001, 'agent-x'));
    recordEvent(bus.db, bus.events, 'src-a', progress(9002));
    const u = recordEvent(bus.db, bus.events, 'src-a', {
      id: 0,
      at: '2030-01-01T00:00:00.000Z',
      source: 'test',
      type: 'agent.state',
      agentId: null,
      issue: 9001,
      runId: null,
      data: { state: 'idle' },
    });

    expect((await page('?issue=9001&type=progress')).events.map((e) => e.id)).toEqual([a.id, b.id]);
    expect((await page('?issue=9001&type=progress,agent.state')).events.map((e) => e.id)).toEqual([
      a.id,
      b.id,
      u.id,
    ]);
    expect((await page('?issue=9001&source=src-b')).events.map((e) => e.id)).toEqual([b.id]);
    expect((await page('?issue=9001&source=src-b,src-a&type=progress')).events).toHaveLength(2);
    expect((await page('?issue=9001&agentId=agent-x')).events.map((e) => e.id)).toEqual([b.id]);
  });

  it('returns stored stream rows and next null on a single page', async () => {
    const row = recordEvent(bus.db, bus.events, 'src-shape', progress(9003, 'ag'));
    const body = await page('?issue=9003');
    expect(body).toEqual({ events: [row], next: null });
    expect(body.events[0]).toMatchObject({
      role: 'src-shape',
      kind: 'progress',
      issue: 9003,
      agentId: 'ag',
    });
  });

  it('returns an empty page for no match', async () => {
    expect(await page('?issue=987654')).toEqual({ events: [], next: null });
  });

  it('applies since inclusively and until exclusively on stored createdAt', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const ids: number[] = [];
    for (const t of [
      '2030-01-01T10:00:00.000Z',
      '2030-01-01T11:00:00.000Z',
      '2030-01-01T12:00:00.000Z',
    ]) {
      vi.setSystemTime(new Date(t));
      ids.push(recordEvent(bus.db, bus.events, 'src-time', progress(9004)).id);
    }
    const ids_ = async (qs: string) => (await page(`?issue=9004&${qs}`)).events.map((e) => e.id);
    expect(await ids_('since=2030-01-01T11:00:00Z')).toEqual([ids[1], ids[2]]);
    expect(await ids_('until=2030-01-01T12:00:00Z')).toEqual([ids[0], ids[1]]);
    expect(await ids_('since=2030-01-01T10:30Z&until=2030-01-01T11:30Z')).toEqual([ids[1]]);
    expect(await ids_('since=2030-01-01T14:00:00%2B02:00&until=2030-01-01T12:00:00.001Z')).toEqual([
      ids[2],
    ]);
  });
});

describe('GET /events pagination', () => {
  it('walks 2500 events with limit 1000 without repeats or skips', async () => {
    const expected: number[] = [];
    bus.db.transaction(() => {
      for (let i = 0; i < 2500; i++) {
        expected.push(recordEvent(bus.db, bus.events, 'src-page', progress(9005)).id);
      }
    });
    const seen: number[] = [];
    let after: number | null = null;
    const sizes: number[] = [];
    do {
      const body: EventPage = await page(
        `?issue=9005&limit=1000${after === null ? '' : `&after=${after}`}`,
      );
      sizes.push(body.events.length);
      seen.push(...body.events.map((e) => e.id));
      after = body.next;
    } while (after !== null);
    expect(sizes).toEqual([1000, 1000, 500]);
    expect(seen).toEqual(expected);
  });

  it('defaults limit to 100', async () => {
    const body = await page('?issue=9005');
    expect(body.events).toHaveLength(100);
    expect(body.next).toBe(body.events[99]?.id);
  });
});

describe('GET /events errors', () => {
  it.each([
    ['unknown key', '?foo=1', 'foo'],
    ['repeated key', '?issue=1&issue=2', 'issue'],
    ['negative issue', '?issue=-1', 'issue'],
    ['non-numeric issue', '?issue=abc', 'issue'],
    ['empty issue', '?issue=', 'issue'],
    ['non-numeric after', '?after=1.5', 'after'],
    ['limit 0', '?limit=0', 'limit'],
    ['limit 1001', '?limit=1001', 'limit'],
    ['limit text', '?limit=x', 'limit'],
    ['empty type entry', '?type=a,,b', 'type'],
    ['empty source', '?source=', 'source'],
    ['empty agentId', '?agentId=', 'agentId'],
    ['since number', '?since=1', 'since'],
    ['since garbage', '?since=2030-13-45T99:99', 'since'],
    ['until date only', '?until=2030-01-01', 'until'],
  ])('answers 400 naming the parameter: %s', async (_name, qs, param) => {
    const res = await get(qs);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(param);
  });

  it('answers 403 for a foreign Host', async () => {
    const res = await get('', { headers: { origin: 'http://evil.example' } });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBeTruthy();
  });

  it('answers 405 for PUT', async () => {
    expect((await get('', { method: 'PUT' })).status).toBe(405);
  });
});

describe('POST /events unchanged', () => {
  it('still ingests hook events', async () => {
    const res = await fetch(`${bus.http.url}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'implementer', cli: 'claude', state: 'idle' }),
    });
    expect(res.status).toBeLessThan(300);
  });
});
