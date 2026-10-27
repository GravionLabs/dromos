import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type EventsDeps, type EventsOptions, runEventsCommand } from './cli-events.js';
import { recordEvent } from './event-store.js';
import { startTestBus, type TestBus } from './test-helpers.js';

let bus: TestBus;
beforeAll(async () => {
  bus = await startTestBus();
});
afterAll(async () => {
  await bus.close();
});

const event = (issue: number | null, type = 'progress', agentId: string | null = null) => ({
  id: 0,
  at: '2030-01-01T00:00:00.000Z',
  source: 'test',
  type,
  agentId,
  issue,
  runId: null,
  data: type === 'progress' ? { line: 'built', agent: 'orchestrator' } : { state: 'idle' },
});

function run(opts: Partial<EventsOptions>, deps: Partial<EventsDeps> = {}) {
  let out = '';
  let err = '';
  const code = runEventsCommand(
    { url: bus.http.url, ...opts },
    {
      stdout: (t) => {
        out += t;
      },
      stderr: (t) => {
        err += t;
      },
      ...deps,
    },
  );
  return code.then((c) => ({ code: c, out, err }));
}

const json = (body: unknown, status = 200) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('runEventsCommand', () => {
  it('maps filters to the query string and prints parseable JSON', async () => {
    const a = recordEvent(bus.db, bus.events, 'src-a', event(7001, 'progress', 'agent-x'));
    recordEvent(bus.db, bus.events, 'src-a', event(7001, 'agent.state'));
    recordEvent(bus.db, bus.events, 'src-a', event(7002));
    const r = await run({ issue: '7001', type: 'progress', agentId: 'agent-x', limit: '10' });
    expect(r.code).toBe(0);
    const body = JSON.parse(r.out) as { events: { id: number }[]; next: number | null };
    expect(body.events.map((e) => e.id)).toEqual([a.id]);
    expect(body.next).toBeNull();
  });

  it('sends every filter as its query parameter', async () => {
    const urls: string[] = [];
    const fake = (async (u: string) => {
      urls.push(u);
      return new Response(JSON.stringify({ events: [], next: null }));
    }) as unknown as typeof fetch;
    await run(
      {
        issue: '1',
        type: 'a,b',
        source: 's',
        kind: 'task,wave',
        agentId: 'g',
        since: '2030-01-01T00:00:00Z',
        until: '2031-01-01T00:00:00Z',
        after: '5',
        limit: '2',
      },
      { fetch: fake },
    );
    const q = new URL(urls[0] as string).searchParams;
    expect(Object.fromEntries(q)).toEqual({
      issue: '1',
      type: 'a,b',
      source: 's',
      kind: 'task,wave',
      agentId: 'g',
      since: '2030-01-01T00:00:00Z',
      until: '2031-01-01T00:00:00Z',
      after: '5',
      limit: '2',
    });
  });

  it('--all pages through 2500 events without repeats', async () => {
    for (let i = 0; i < 2500; i++) recordEvent(bus.db, bus.events, 'bulk', event(8000));
    const r = await run({ issue: '8000', all: true, limit: '1000' });
    expect(r.code).toBe(0);
    const body = JSON.parse(r.out) as { events: { id: number }[]; next: number | null };
    const ids = body.events.map((e) => e.id);
    expect(ids).toHaveLength(2500);
    expect(new Set(ids).size).toBe(2500);
    expect(body.next).toBeNull();
  });

  it('without --all returns one page and its cursor', async () => {
    const r = await run({ issue: '8000', limit: '1000' });
    const body = JSON.parse(r.out) as { events: unknown[]; next: number | null };
    expect(body.events).toHaveLength(1000);
    expect(body.next).not.toBeNull();
  });

  it('table has a header, one line per event and no data column', async () => {
    const t1 = recordEvent(bus.db, bus.events, 'tbl-src', event(7100, 'progress', 'tbl-agent'));
    recordEvent(bus.db, bus.events, 'tbl-src', event(null, 'agent.state'));
    const r = await run({ source: 'tbl-src', table: true, after: String(t1.id - 1) });
    const lines = r.out.trimEnd().split('\n');
    expect(lines[0]?.split(/\s+/)).toEqual([
      'id',
      'createdAt',
      'issue',
      'source',
      'type',
      'agentId',
    ]);
    expect(lines).toHaveLength(3);
    const cells = lines[1]?.split(/\s+/) ?? [];
    expect(cells[1]).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(cells.filter((_, i) => i !== 1)).toEqual([
      String(t1.id),
      '7100',
      'tbl-src',
      'progress',
      'tbl-agent',
    ]);
    expect(lines[2]?.split(/\s+/).slice(2)).toEqual(['-', 'tbl-src', 'agent.state', '-']);
    expect(r.out).not.toContain('built');
  });

  it('defaults to table on a TTY and JSON otherwise; --json overrides a TTY', async () => {
    recordEvent(bus.db, bus.events, 'tty-src', event(7200));
    const q = { source: 'tty-src' };
    expect((await run(q, { isTTY: true })).out).toMatch(/^id /);
    expect((await run(q, { isTTY: false })).out).toMatch(/^\{/);
    expect((await run({ ...q, json: true }, { isTTY: true })).out).toMatch(/^\{/);
  });

  it('prints the server error to stderr and exits 2 on 400', async () => {
    const r = await run({ limit: '5000' });
    expect(r.code).toBe(2);
    expect(r.err).toContain('limit');
    expect(r.out).toBe('');
  });

  it('prints a hint and exits 1 when the bus is unreachable', async () => {
    const r = await run({ url: 'http://127.0.0.1:1' });
    expect(r.code).toBe(1);
    expect(r.err).toContain('bus not running at http://127.0.0.1:1');
  });

  it('strips terminal escape sequences from table cells', async () => {
    const row = {
      id: 1,
      role: 'a\u001b[31mred',
      kind: 'k\u0007',
      data: {},
      createdAt: '2030-01-01T00:00:00.000Z',
      agentId: 'x\u009by',
      issue: 1,
      runId: null,
    };
    const r = await run({ table: true }, { fetch: json({ events: [row], next: null }) });
    const bad = [...r.out].filter((c) => {
      const n = c.charCodeAt(0);
      return c !== '\n' && (n < 0x20 || (n >= 0x7f && n <= 0x9f));
    });
    expect(bad).toEqual([]);
    expect(r.out).toContain('a?[31mred');
  });

  it('stops with exit 1 when --all gets a non-advancing cursor', async () => {
    const r = await run({ all: true, after: '5' }, { fetch: json({ events: [], next: 5 }) });
    expect(r.code).toBe(1);
    expect(r.err).toContain('non-advancing cursor');
  });

  it('exits 1 on a non-400 failure with and without an error body', async () => {
    const withBody = await run({}, { fetch: json({ error: 'forbidden' }, 403) });
    expect(withBody.code).toBe(1);
    expect(withBody.err).toContain('forbidden');
    const noBody = await run(
      {},
      { fetch: (async () => new Response('oops', { status: 500 })) as unknown as typeof fetch },
    );
    expect(noBody.code).toBe(1);
    expect(noBody.err).toContain('HTTP 500');
  });

  it('exits 1 on a 200 response that is not an event page', async () => {
    const r = await run({}, { fetch: json({ nope: true }) });
    expect(r.code).toBe(1);
  });
});
