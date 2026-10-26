import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { recordEvent } from './event-store.js';
import type { RunMetrics, RunMetricsAggregate } from './run-metrics.js';
import { startTestBus, type TestBus } from './test-helpers.js';

let bus: TestBus;
beforeAll(async () => {
  bus = await startTestBus();
  vi.useFakeTimers({ toFake: ['Date'] });
});
afterAll(async () => {
  vi.useRealTimers();
  await bus.close();
});

function rec(issue: number | null, at: string, kind: string, data: Record<string, unknown>) {
  vi.setSystemTime(new Date(at));
  const type = kind === 'GATE' ? 'attention' : 'progress';
  return recordEvent(bus.db, bus.events, 'test', {
    id: 0,
    at,
    source: 'test',
    type,
    agentId: null,
    issue,
    runId: null,
    data:
      type === 'attention'
        ? { kind, summary: 'm', pr: null }
        : { line: 'l', agent: 'orchestrator', ...data },
  });
}

const url = (p: string) => `${bus.http.url}${p}`;
type Multi = { runs: RunMetrics[]; aggregate: RunMetricsAggregate };

// Issues 7101 and 7102 live in 2031; 7103 has events only outside the window.
beforeAll(() => {
  rec(7101, '2031-01-01T00:00:00.000Z', 'progress', {});
  rec(7101, '2031-01-01T00:01:00.000Z', 'progress', {});
  rec(7101, '2031-02-01T00:00:00.000Z', 'GATE', {});
  rec(7102, '2031-01-01T00:00:30.000Z', 'progress', {});
  rec(7103, '2032-01-01T00:00:00.000Z', 'progress', {});
  rec(null, '2031-01-01T00:00:00.000Z', 'progress', {});
});

function recRaw(
  issue: number,
  at: string,
  type: string,
  data: Record<string, unknown>,
  agentId: string | null = null,
) {
  vi.setSystemTime(new Date(at));
  return recordEvent(bus.db, bus.events, 'test', {
    id: 0,
    at,
    source: 'test',
    type,
    agentId,
    issue,
    runId: null,
    data,
  });
}

// Issue 7200: two phases, a fix-round and usage from the database, end to end.
beforeAll(() => {
  const line = { line: 'l', agent: 'orchestrator' };
  recRaw(7200, '2033-01-01T00:00:00.000Z', 'progress', {
    ...line,
    kind: 'phase',
    fields: { phase: 'plan' },
  });
  recRaw(7200, '2033-01-01T00:01:00.000Z', 'progress', {
    ...line,
    kind: 'phase',
    fields: { phase: 'build' },
  });
  recRaw(7200, '2033-01-01T00:01:30.000Z', 'progress', { ...line, kind: 'other' });
  recRaw(7200, '2033-01-01T00:02:00.000Z', 'usage', {
    contextTokens: 5,
    costUsd: 0.75,
    model: null,
  });
});

describe('GET /runs/{issue}/metrics', () => {
  it('reports phases, kinds and usage from stored events', async () => {
    const m = (await (await fetch(url('/runs/7200/metrics'))).json()) as RunMetrics;
    expect(m.durations.phases).toEqual({ build: 60, plan: 60 });
    expect(m.progress.byKind).toEqual({ other: 1, phase: 2 });
    expect(m.usage).toEqual({ tokensIn: null, tokensOut: null, usd: 0.75, measured: true });
  });

  it('until is exclusive and since inclusive', async () => {
    const at = (qs: string) =>
      fetch(url(`/runs/7101/metrics${qs}`)).then((r) => r.json() as Promise<RunMetrics>);
    expect((await at('?until=2031-01-01T00:01Z')).events).toBe(1);
    expect((await at('?since=2031-01-01T00:01Z&until=2031-01-01T00:01:00.001Z')).events).toBe(1);
  });

  it('answers 404 for an issue beyond the safe integer range and for other paths', async () => {
    expect((await fetch(url('/runs/99999999999999999999/metrics'))).status).toBe(404);
    expect((await fetch(url('/runs/abc/metrics'))).status).toBe(404);
    expect((await fetch(url('/runs/7101'))).status).toBe(404);
    expect((await fetch(url('/runs/7101/metrics/x'))).status).toBe(404);
  });

  it('answers 500 without leaking the internal error text', async () => {
    const spy = vi.spyOn(bus.db, 'queryEvents').mockImplementation(() => {
      throw new Error('secret db detail');
    });
    try {
      const res = await fetch(url('/runs/7101/metrics'));
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'internal error' });
    } finally {
      spy.mockRestore();
    }
  });

  it('returns the RunMetrics shape for the issue', async () => {
    const res = await fetch(url('/runs/7101/metrics'));
    expect(res.status).toBe(200);
    const m = (await res.json()) as RunMetrics;
    expect(m.issue).toBe(7101);
    expect(m.events).toBe(3);
    expect(m.usage).toEqual({ tokensIn: null, tokensOut: null, usd: null, measured: false });
  });

  it('since/until change the counts', async () => {
    const m = (await (
      await fetch(url('/runs/7101/metrics?since=2031-01-01T00:00Z&until=2031-01-15T00:00Z'))
    ).json()) as RunMetrics;
    expect(m.events).toBe(2);
    const later = (await (
      await fetch(url('/runs/7101/metrics?since=2031-01-15T00:00Z'))
    ).json()) as RunMetrics;
    expect(later.events).toBe(1);
  });

  it('returns empty metrics for an issue without events', async () => {
    const res = await fetch(url('/runs/999999/metrics'));
    expect(res.status).toBe(200);
    expect(((await res.json()) as RunMetrics).events).toBe(0);
  });

  it('answers 400 naming the parameter', async () => {
    for (const [qs, name] of [
      ['?bogus=1', 'bogus'],
      ['?since=2031-01-01T00:00Z&since=2031-01-02T00:00Z', 'since'],
      ['?since=nope', 'since'],
      ['?issues=1', 'issues'],
    ] as const) {
      const res = await fetch(url(`/runs/7101/metrics${qs}`));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain(name);
    }
  });

  it('rejects non-GET with 405 and a foreign host with 403', async () => {
    expect((await fetch(url('/runs/7101/metrics'), { method: 'POST' })).status).toBe(405);
    const res = await fetch(url('/runs/7101/metrics'), {
      headers: { origin: 'http://evil.example' },
    });
    expect(res.status).toBe(403);
  });
});

describe('GET /runs/metrics', () => {
  it('lists duplicate ids once', async () => {
    const body = (await (await fetch(url('/runs/metrics?issues=7102,7102'))).json()) as Multi;
    expect(body.runs.map((r) => r.issue)).toEqual([7102]);
  });

  it('accepts exactly 100 issues', async () => {
    const list = Array.from({ length: 100 }, (_, i) => 8000 + i).join(',');
    expect((await fetch(url(`/runs/metrics?issues=${list}`))).status).toBe(200);
  });

  it('ignores since when issues is given beyond filtering the window', async () => {
    const body = (await (
      await fetch(url('/runs/metrics?issues=7101,7102&since=2031-01-01T00:00:45Z'))
    ).json()) as Multi;
    expect(body.runs.map((r) => [r.issue, r.events])).toEqual([
      [7101, 2],
      [7102, 0],
    ]);
  });

  it('keeps event-less requested issues out of the aggregate means', async () => {
    const body = (await (await fetch(url('/runs/metrics?issues=7102,999998'))).json()) as Multi;
    expect(body.runs).toHaveLength(2);
    expect(body.aggregate.runs).toBe(1);
    expect(body.aggregate.mean.events).toBe(1);
  });

  it('returns per-issue objects and the aggregate for ?issues=', async () => {
    const res = await fetch(url('/runs/metrics?issues=7101,7102'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Multi;
    expect(body.runs.map((r) => [r.issue, r.events])).toEqual([
      [7101, 3],
      [7102, 1],
    ]);
    expect(body.aggregate.events).toBe(4);
  });

  it('discovers issues from ?since= and honours until', async () => {
    const body = (await (
      await fetch(url('/runs/metrics?since=2031-01-01T00:00Z&until=2031-01-15T00:00Z'))
    ).json()) as Multi;
    expect(body.runs.map((r) => [r.issue, r.events])).toEqual([
      [7101, 2],
      [7102, 1],
    ]);
    expect(body.aggregate.events).toBe(3);
  });

  it('answers 400 naming the parameter', async () => {
    for (const [qs, name] of [
      ['', 'issues'],
      ['?until=2031-01-01T00:00Z', 'issues'],
      ['?issues=1,,2', 'issues'],
      ['?issues=abc', 'issues'],
      ['?issues=1&issues=2', 'issues'],
      [`?issues=${Array.from({ length: 101 }, (_, i) => i).join(',')}`, 'issues'],
      ['?issues=1&x=1', 'x'],
    ] as const) {
      const res = await fetch(url(`/runs/metrics${qs}`));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain(name);
    }
  });

  it('rejects non-GET with 405 and a foreign host with 403', async () => {
    expect((await fetch(url('/runs/metrics?issues=1'), { method: 'POST' })).status).toBe(405);
    const res = await fetch(url('/runs/metrics?issues=1'), {
      headers: { origin: 'http://evil.example' },
    });
    expect(res.status).toBe(403);
  });
});
