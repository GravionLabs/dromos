import { describe, expect, it } from 'vitest';
import type { EventPage, EventQuery, EventRecord } from './db.js';
import { aggregateRunMetrics, collectEvents, computeRunMetrics } from './run-metrics.js';

let nextId = 1;
function ev(
  at: string,
  kind: string,
  data: unknown,
  agentId: string | null = 'orch-1',
  role = 'orchestrator',
): EventRecord {
  return { id: nextId++, role, kind, data, createdAt: at, agentId, issue: 137, runId: null };
}
const phase = (at: string, name: string) =>
  ev(at, 'progress', { kind: 'phase', message: name, fields: { phase: name } });
const usage = (at: string, agent: string, costUsd: number | null) =>
  ev(at, 'usage', { contextTokens: 100, costUsd, model: null }, agent, 'implementer');

function fixture(): EventRecord[] {
  return [
    phase('2026-01-01T00:00:00.000Z', 'plan'),
    phase('2026-01-01T00:01:00.000Z', 'implement'),
    ev('2026-01-01T00:02:00.000Z', 'progress', { kind: 'fix-round', message: 'r1' }),
    ev('2026-01-01T00:03:00.000Z', 'progress', { kind: 'fix-round', message: 'r2' }),
    ev('2026-01-01T00:03:30.000Z', 'progress', { message: 'no kind' }),
    ev('2026-01-01T00:04:00.000Z', 'attention', { kind: 'GATE', message: 'approve?' }),
    usage('2026-01-01T00:04:30.000Z', 'impl-1', 0.5),
    usage('2026-01-01T00:05:00.000Z', 'impl-1', 1.25),
    usage('2026-01-01T00:05:30.000Z', 'impl-1', null),
    usage('2026-01-01T00:05:45.000Z', 'rev-1', 0.25),
    phase('2026-01-01T00:06:00.000Z', 'plan'),
    ev('2026-01-01T00:07:00.000Z', 'progress', { kind: 'complete', message: 'done' }),
  ];
}

describe('computeRunMetrics prototype-named keys', () => {
  it('counts constructor and __proto__ kinds as ordinary keys', () => {
    const m = computeRunMetrics(1, [
      ev('2026-01-01T00:00:00.000Z', 'progress', { kind: 'constructor' }),
      ev('2026-01-01T00:00:01.000Z', 'progress', { kind: '__proto__' }),
      ev('2026-01-01T00:00:02.000Z', 'progress', { kind: '__proto__' }),
    ]);
    expect(Object.entries(m.progress.byKind)).toEqual([
      ['__proto__', 2],
      ['constructor', 1],
    ]);
  });
});

describe('computeRunMetrics', () => {
  it('matches the snapshot for a full run', () => {
    expect(computeRunMetrics(137, fixture())).toMatchInlineSnapshot(`
      {
        "agents": [
          {
            "agentId": "impl-1",
            "events": 3,
            "role": "implementer",
          },
          {
            "agentId": "orch-1",
            "events": 8,
            "role": "orchestrator",
          },
          {
            "agentId": "rev-1",
            "events": 1,
            "role": "implementer",
          },
        ],
        "attention": {
          "byKind": {
            "GATE": 1,
          },
        },
        "blocked": false,
        "durations": {
          "firstAt": "2026-01-01T00:00:00.000Z",
          "lastAt": "2026-01-01T00:07:00.000Z",
          "phases": {
            "implement": 300,
            "plan": 120,
          },
          "seconds": 420,
        },
        "events": 12,
        "findings": {
          "fingerprints": {},
          "total": 0,
        },
        "fixRounds": 0,
        "issue": 137,
        "progress": {
          "byKind": {
            "complete": 1,
            "fix-round": 2,
            "phase": 3,
            "unspecified": 1,
          },
        },
        "unansweredQuestions": 0,
        "usage": {
          "byRole": {},
          "measured": true,
          "tokensIn": null,
          "tokensOut": null,
          "usd": 1.5,
        },
      }
    `);
  });

  it('is independent of input order', () => {
    expect(computeRunMetrics(137, fixture().reverse())).toEqual(computeRunMetrics(137, fixture()));
  });

  it('reports usd null and measured false without usage events', () => {
    const m = computeRunMetrics(1, [phase('2026-01-01T00:00:00.000Z', 'plan')]);
    expect(m.usage).toEqual({
      tokensIn: null,
      tokensOut: null,
      usd: null,
      measured: false,
      byRole: {},
    });
  });

  it('reports usd null when every costUsd is null', () => {
    const m = computeRunMetrics(1, [
      usage('2026-01-01T00:00:00.000Z', 'a', null),
      usage('2026-01-01T00:00:01.000Z', 'b', null),
    ]);
    expect(m.usage.usd).toBeNull();
    expect(m.usage.measured).toBe(false);
  });

  it('handles an empty stream', () => {
    expect(computeRunMetrics(9, [])).toEqual({
      issue: 9,
      events: 0,
      progress: { byKind: {} },
      attention: { byKind: {} },
      usage: { tokensIn: null, tokensOut: null, usd: null, measured: false, byRole: {} },
      durations: { firstAt: null, lastAt: null, seconds: 0 },
      agents: [],
      fixRounds: 0,
      blocked: false,
      unansweredQuestions: 0,
      findings: { total: 0, fingerprints: {} },
    });
  });

  it('gives a single event zero seconds and no phases without phase events', () => {
    const m = computeRunMetrics(1, [ev('2026-01-01T00:00:00.000Z', 'progress', { kind: 'task' })]);
    expect(m.durations).toEqual({
      firstAt: '2026-01-01T00:00:00.000Z',
      lastAt: '2026-01-01T00:00:00.000Z',
      seconds: 0,
    });
  });

  it('ignores phase events without a string fields.phase', () => {
    const m = computeRunMetrics(1, [
      ev('2026-01-01T00:00:00.000Z', 'progress', { kind: 'phase', fields: { phase: 3 } }),
      ev('2026-01-01T00:00:10.000Z', 'progress', { kind: 'phase' }),
    ]);
    expect(m.durations.phases).toBeUndefined();
    expect(m.progress.byKind).toEqual({ phase: 2 });
  });
});

describe('aggregateRunMetrics', () => {
  const a = computeRunMetrics(137, fixture());
  const b = computeRunMetrics(2, [
    ev('2026-02-01T00:00:00.000Z', 'progress', { kind: 'phase', fields: { phase: 'x' } }),
    ev('2026-02-01T00:00:20.000Z', 'attention', { kind: 'FAILED', message: 'x' }),
  ]);

  it('sums counts and averages over runs, usd over measured runs only', () => {
    const agg = aggregateRunMetrics([a, b]);
    expect(agg).toEqual({
      runs: 2,
      events: 14,
      progress: { byKind: { complete: 1, 'fix-round': 2, phase: 4, unspecified: 1 } },
      attention: { byKind: { FAILED: 1, GATE: 1 } },
      usage: { usd: 1.5, measured: true, byRole: {} },
      durations: { seconds: 440, phases: { implement: 300, plan: 120, x: 20 } },
      mean: { seconds: 220, events: 7, usd: 1.5 },
      fixRounds: 0,
      blockedRuns: 0,
      unansweredQuestions: 0,
      repeatedFindings: [],
    });
  });

  it('gives usd null when no run was measured', () => {
    const agg = aggregateRunMetrics([b]);
    expect(agg.usage).toEqual({ usd: null, measured: false, byRole: {} });
    expect(agg.mean.usd).toBeNull();
  });

  it('handles no runs', () => {
    expect(aggregateRunMetrics([])).toMatchObject({
      runs: 0,
      events: 0,
      mean: { seconds: 0, events: 0, usd: null },
    });
  });
});

describe('collectEvents', () => {
  it('pages through next until exhausted and forwards filters', () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      ev(`2026-01-01T00:00:0${i}.000Z`, 'progress', {}),
    );
    const calls: EventQuery[] = [];
    const db = {
      queryEvents(q: EventQuery): EventPage {
        calls.push(q);
        const start = q.after === undefined ? 0 : rows.findIndex((r) => r.id === q.after) + 1;
        const events = rows.slice(start, start + 2);
        const last = events[events.length - 1];
        return { events, next: start + 2 < rows.length && last ? last.id : null };
      },
    };
    const got = collectEvents(db, { issue: 137, since: '2026-01-01T00:00:00.000Z' });
    expect(got).toEqual(rows);
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.issue === 137 && c.limit === 1000)).toBe(true);
    expect(calls[1]?.after).toBe(rows[1]?.id);
  });

  it('returns an empty list for an empty first page', () => {
    expect(collectEvents({ queryEvents: () => ({ events: [], next: null }) }, {})).toEqual([]);
  });
});

const runner = (at: string, kind: string, data: unknown) => ev(at, kind, data, null, 'dromos');
const phaseEnd = (
  at: string,
  kind: 'phase.finished' | 'phase.failed',
  name: string,
  durationMs: number,
  usageData: unknown,
  extra: object = {},
) => runner(at, kind, { phase: name, durationMs, usage: usageData, ...extra });
const finding = (at: string, fingerprint: string) =>
  runner(at, 'outcome.finding', { fingerprint, blocking: true, fixed: false });

describe('computeRunMetrics runner events', () => {
  const events = [
    phaseEnd(
      '2026-01-01T00:01:00.000Z',
      'phase.finished',
      'planner',
      60000,
      { inputTokens: 100, outputTokens: 10, costUsd: 0.5 },
      { unansweredQuestions: 2 },
    ),
    phaseEnd('2026-01-01T00:03:00.000Z', 'phase.finished', 'implementer', 120000, {
      inputTokens: 1000,
      outputTokens: 200,
      costUsd: null,
    }),
    phaseEnd('2026-01-01T00:04:00.000Z', 'phase.failed', 'implementer', 30000, null),
    finding('2026-01-01T00:04:10.000Z', 'aa'),
    finding('2026-01-01T00:04:20.000Z', 'aa'),
    finding('2026-01-01T00:04:30.000Z', 'bb'),
    runner('2026-01-01T00:05:00.000Z', 'outcome.fixRound', { cause: 'review_findings' }),
    runner('2026-01-01T00:06:00.000Z', 'run.state', { state: 'blocked', round: 1, previous: null }),
  ];

  it('sums phase durations, usage per role, fix rounds, questions and findings', () => {
    const m = computeRunMetrics(7, events);
    expect(m.durations.phases).toEqual({ implementer: 150, planner: 60 });
    expect(m.usage).toEqual({
      tokensIn: 1100,
      tokensOut: 210,
      usd: 0.5,
      measured: true,
      byRole: {
        implementer: { phases: 1, inputTokens: 1000, outputTokens: 200, usd: null },
        planner: { phases: 1, inputTokens: 100, outputTokens: 10, usd: 0.5 },
      },
    });
    expect(m.fixRounds).toBe(1);
    expect(m.blocked).toBe(true);
    expect(m.unansweredQuestions).toBe(2);
    expect(m.findings).toEqual({ total: 3, fingerprints: { aa: 2, bb: 1 } });
  });

  it('reports zeros and null usage for a run without runner events', () => {
    const m = computeRunMetrics(7, [ev('2026-01-01T00:00:00.000Z', 'progress', { kind: 'x' })]);
    expect(m.fixRounds).toBe(0);
    expect(m.blocked).toBe(false);
    expect(m.unansweredQuestions).toBe(0);
    expect(m.findings).toEqual({ total: 0, fingerprints: {} });
    expect(m.usage.byRole).toEqual({});
    expect(m.usage.tokensIn).toBeNull();
  });

  it('treats an attempt settled as blocked as a blocked run', () => {
    const m = computeRunMetrics(7, [
      runner('2026-01-01T00:00:00.000Z', 'attempt.settled', { outcome: 'blocked' }),
    ]);
    expect(m.blocked).toBe(true);
  });

  it('aggregates and lists fingerprints repeated across runs', () => {
    const a = computeRunMetrics(1, [finding('2026-01-01T00:00:00.000Z', 'aa'), ...events]);
    const b = computeRunMetrics(2, [
      finding('2026-01-01T00:00:00.000Z', 'aa'),
      finding('2026-01-01T00:00:01.000Z', 'cc'),
    ]);
    const agg = aggregateRunMetrics([a, b]);
    expect(agg.repeatedFindings).toEqual([{ fingerprint: 'aa', runs: [1, 2], count: 4 }]);
    expect(agg.fixRounds).toBe(1);
    expect(agg.blockedRuns).toBe(1);
    expect(agg.unansweredQuestions).toBe(2);
    expect(agg.durations.phases).toEqual({ implementer: 150, planner: 60 });
    expect(agg.usage.byRole.planner).toEqual({
      phases: 1,
      inputTokens: 100,
      outputTokens: 10,
      usd: 0.5,
    });
  });
});
