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
    const r = await run({ issue: '7001', table: true });
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
    expect(lines[1]).toContain('src-a');
    expect(lines[1]).toContain('agent-x');
    expect(lines[2]).toContain('-');
    expect(r.out).not.toContain('built');
  });

  it('defaults to table on a TTY and JSON otherwise; --json overrides a TTY', async () => {
    expect((await run({ issue: '7002' }, { isTTY: true })).out).toMatch(/^id /);
    expect((await run({ issue: '7002' }, { isTTY: false })).out).toMatch(/^\{/);
    expect((await run({ issue: '7002', json: true }, { isTTY: true })).out).toMatch(/^\{/);
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
});
