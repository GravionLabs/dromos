import type { Db, EventQuery, EventRecord } from './db.js';
import { MAX_QUERY_LIMIT } from './event-query.js';

export type RunMetrics = {
  issue: number;
  events: number;
  progress: { byKind: Record<string, number> };
  attention: { byKind: Record<string, number> };
  /** Tokens and `usd` are null unless measured (phase usage or usage events); never estimated. */
  usage: {
    tokensIn: number | null;
    tokensOut: number | null;
    usd: number | null;
    measured: boolean;
    /** Per role (phase name: planner, implementer, reviewer, ...); only phases that reported usage. */
    byRole: Record<string, RoleUsage>;
  };
  durations: {
    firstAt: string | null;
    lastAt: string | null;
    seconds: number;
    phases?: Record<string, number>;
  };
  agents: Array<{ agentId: string; role?: string; events: number }>;
  /** Fix rounds started (`outcome.fixRound`). */
  fixRounds: number;
  /** True when the run entered the `blocked` state or an attempt settled as `blocked`. */
  blocked: boolean;
  /** Questions still unanswered after the planner phase (`phase.finished`). */
  unansweredQuestions: number;
  /** Blocking review findings (`outcome.finding`): how often each fingerprint was reported. */
  findings: { total: number; fingerprints: Record<string, number> };
};

/** Tokens and cost of the phases of one role (`phase.finished` / `phase.failed`). */
export type RoleUsage = {
  phases: number;
  inputTokens: number;
  outputTokens: number;
  /** Null when no phase of the role reported a cost. */
  usd: number | null;
};

export type RunMetricsAggregate = {
  runs: number;
  events: number;
  progress: { byKind: Record<string, number> };
  attention: { byKind: Record<string, number> };
  usage: { usd: number | null; measured: boolean; byRole: Record<string, RoleUsage> };
  durations: { seconds: number; phases: Record<string, number> };
  mean: { seconds: number; events: number; usd: number | null };
  fixRounds: number;
  blockedRuns: number;
  unansweredQuestions: number;
  /** Fingerprints reported in two or more runs, most runs first. */
  repeatedFindings: Array<{ fingerprint: string; runs: number[]; count: number }>;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Counter keyed by client-controlled strings: no prototype, so `constructor`/`__proto__` are plain keys. */
function newCounts(): Record<string, number> {
  return Object.create(null) as Record<string, number>;
}

function bump(counts: Record<string, number>, key: string, by = 1): void {
  counts[key] = (counts[key] ?? 0) + by;
}

function sortedCounts(counts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

function dataKind(e: EventRecord): string | undefined {
  return isRecord(e.data) && typeof e.data.kind === 'string' ? e.data.kind : undefined;
}

function phaseName(e: EventRecord): string | undefined {
  if (e.kind !== 'progress' || dataKind(e) !== 'phase' || !isRecord(e.data)) {
    return undefined;
  }
  const fields = e.data.fields;
  return isRecord(fields) && typeof fields.phase === 'string' ? fields.phase : undefined;
}

/** createdAt is written by the bus; an unparsable value counts as 0 rather than poisoning sums with NaN. */
function ms(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

function chronological(events: readonly EventRecord[]): EventRecord[] {
  return [...events].sort((a, b) => ms(a.createdAt) - ms(b.createdAt) || a.id - b.id);
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function roleEntry(roles: Record<string, RoleUsage>, role: string): RoleUsage {
  let entry = roles[role];
  if (entry === undefined) {
    entry = { phases: 0, inputTokens: 0, outputTokens: 0, usd: null };
    roles[role] = entry;
  }
  return entry;
}

function sortedRoles(roles: Record<string, RoleUsage>): Record<string, RoleUsage> {
  return Object.fromEntries(Object.entries(roles).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function computeUsd(sorted: readonly EventRecord[]): number | null {
  // costUsd is a cumulative per-agent sample, so the last non-null one per agent is that agent's
  // total, summed across agents. Usage without an agentId cannot be told apart and is pooled as
  // one agent: several anonymous agents therefore undercount (only the latest sample is kept).
  const lastByAgent = new Map<string, number>();
  for (const e of sorted) {
    if (e.kind !== 'usage' || !isRecord(e.data)) {
      continue;
    }
    const cost = e.data.costUsd;
    if (typeof cost === 'number') {
      lastByAgent.set(e.agentId ?? '', cost);
    }
  }
  if (lastByAgent.size === 0) return null;
  let sum = 0;
  for (const v of lastByAgent.values()) {
    sum += v;
  }
  return sum;
}

export function computeRunMetrics(issue: number, events: readonly EventRecord[]): RunMetrics {
  const sorted = chronological(events);
  const progress = newCounts();
  const attention = newCounts();
  const agents = new Map<string, { role?: string; events: number }>();

  for (const e of sorted) {
    if (e.kind === 'progress') {
      bump(progress, dataKind(e) ?? 'unspecified');
    } else if (e.kind === 'attention') {
      bump(attention, dataKind(e) ?? 'unspecified');
    }
    if (e.agentId !== null) {
      const entry = agents.get(e.agentId) ?? { events: 0 };
      entry.events += 1;
      entry.role = e.role;
      agents.set(e.agentId, entry);
    }
  }

  const firstAt = sorted[0]?.createdAt ?? null;
  const lastAt = sorted[sorted.length - 1]?.createdAt ?? null;
  const lastMs = lastAt === null ? 0 : ms(lastAt);
  const seconds = firstAt === null ? 0 : (lastMs - ms(firstAt)) / 1000;

  const phaseEvents = sorted.filter((e) => phaseName(e) !== undefined);
  const durations: RunMetrics['durations'] = { firstAt, lastAt, seconds };
  if (phaseEvents.length > 0) {
    const phases = newCounts();
    phaseEvents.forEach((e, i) => {
      const next = phaseEvents[i + 1];
      const end = next ? ms(next.createdAt) : lastMs;
      bump(phases, phaseName(e) as string, (end - ms(e.createdAt)) / 1000);
    });
    durations.phases = sortedCounts(phases);
  }

  // Runner events: exact phase durations and usage (the phase name is the role), outcomes, blocking.
  const phaseSeconds = newCounts();
  const byRole = Object.create(null) as Record<string, RoleUsage>;
  const fingerprints = newCounts();
  let findingTotal = 0;
  let unansweredQuestions = 0;
  let fixRounds = 0;
  let blocked = false;
  let tokensIn = 0;
  let tokensOut = 0;
  let tokensMeasured = false;
  let phaseUsd: number | null = null;
  for (const e of sorted) {
    const d = isRecord(e.data) ? e.data : {};
    if (e.kind === 'phase.finished' || e.kind === 'phase.failed') {
      const phase = typeof d.phase === 'string' ? d.phase : 'unspecified';
      bump(phaseSeconds, phase, num(d.durationMs) / 1000);
      if (e.kind === 'phase.finished') unansweredQuestions += num(d.unansweredQuestions);
      if (isRecord(d.usage)) {
        const role = roleEntry(byRole, phase);
        role.phases += 1;
        role.inputTokens += num(d.usage.inputTokens);
        role.outputTokens += num(d.usage.outputTokens);
        tokensIn += num(d.usage.inputTokens);
        tokensOut += num(d.usage.outputTokens);
        tokensMeasured = true;
        if (typeof d.usage.costUsd === 'number') {
          role.usd = (role.usd ?? 0) + d.usage.costUsd;
          phaseUsd = (phaseUsd ?? 0) + d.usage.costUsd;
        }
      }
    } else if (e.kind === 'outcome.fixRound') {
      fixRounds += 1;
    } else if (e.kind === 'outcome.finding' && typeof d.fingerprint === 'string') {
      bump(fingerprints, d.fingerprint);
      findingTotal += 1;
    } else if (e.kind === 'run.state' && d.state === 'blocked') {
      blocked = true;
    } else if (e.kind === 'attempt.settled' && d.outcome === 'blocked') {
      blocked = true;
    }
  }
  if (Object.keys(phaseSeconds).length > 0) {
    durations.phases = sortedCounts(phaseSeconds);
  }

  const usd = computeUsd(sorted) ?? phaseUsd;
  return {
    issue,
    events: sorted.length,
    progress: { byKind: sortedCounts(progress) },
    attention: { byKind: sortedCounts(attention) },
    usage: {
      tokensIn: tokensMeasured ? tokensIn : null,
      tokensOut: tokensMeasured ? tokensOut : null,
      usd,
      measured: usd !== null || tokensMeasured,
      byRole: sortedRoles(byRole),
    },
    durations,
    agents: [...agents.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([agentId, v]) => ({ agentId, role: v.role, events: v.events })),
    fixRounds,
    blocked,
    unansweredQuestions,
    findings: { total: findingTotal, fingerprints: sortedCounts(fingerprints) },
  };
}

export function aggregateRunMetrics(runs: readonly RunMetrics[]): RunMetricsAggregate {
  const progress = newCounts();
  const attention = newCounts();
  let events = 0;
  let seconds = 0;
  let usd = 0;
  let measuredRuns = 0;
  let fixRounds = 0;
  let blockedRuns = 0;
  let unansweredQuestions = 0;
  const phases = newCounts();
  const byRole = Object.create(null) as Record<string, RoleUsage>;
  const seen = new Map<string, { runs: number[]; count: number }>();
  for (const r of runs) {
    fixRounds += r.fixRounds;
    unansweredQuestions += r.unansweredQuestions;
    if (r.blocked) blockedRuns += 1;
    for (const [k, n] of Object.entries(r.durations.phases ?? {})) {
      bump(phases, k, n);
    }
    for (const [role, u] of Object.entries(r.usage.byRole)) {
      const t = roleEntry(byRole, role);
      t.phases += u.phases;
      t.inputTokens += u.inputTokens;
      t.outputTokens += u.outputTokens;
      if (u.usd !== null) t.usd = (t.usd ?? 0) + u.usd;
    }
    for (const [fp, n] of Object.entries(r.findings.fingerprints)) {
      const entry = seen.get(fp) ?? { runs: [], count: 0 };
      entry.runs.push(r.issue);
      entry.count += n;
      seen.set(fp, entry);
    }
    events += r.events;
    seconds += r.durations.seconds;
    for (const [k, n] of Object.entries(r.progress.byKind)) {
      bump(progress, k, n);
    }
    for (const [k, n] of Object.entries(r.attention.byKind)) {
      bump(attention, k, n);
    }
    if (r.usage.usd !== null) {
      usd += r.usage.usd;
      measuredRuns += 1;
    }
  }
  const n = runs.length;
  return {
    runs: n,
    events,
    progress: { byKind: sortedCounts(progress) },
    attention: { byKind: sortedCounts(attention) },
    usage: {
      usd: measuredRuns > 0 ? usd : null,
      measured: measuredRuns > 0,
      byRole: sortedRoles(byRole),
    },
    durations: { seconds, phases: sortedCounts(phases) },
    fixRounds,
    blockedRuns,
    unansweredQuestions,
    repeatedFindings: [...seen.entries()]
      .filter(([, v]) => v.runs.length > 1)
      .map(([fingerprint, v]) => ({ fingerprint, runs: v.runs, count: v.count }))
      .sort((a, b) => b.runs.length - a.runs.length || (a.fingerprint < b.fingerprint ? -1 : 1)),
    // usd mean is over measured runs only, so unmeasured runs do not drag it down.
    mean: {
      seconds: n > 0 ? seconds / n : 0,
      events: n > 0 ? events / n : 0,
      usd: measuredRuns > 0 ? usd / measuredRuns : null,
    },
  };
}

/** Pages through `queryEvents` so callers never receive a truncated page. */
export function collectEvents(
  db: Pick<Db, 'queryEvents'>,
  query: Omit<EventQuery, 'after' | 'limit'>,
): EventRecord[] {
  const all: EventRecord[] = [];
  let after: number | undefined;
  for (;;) {
    const page = db.queryEvents({ ...query, after, limit: MAX_QUERY_LIMIT });
    all.push(...page.events);
    if (page.next === null) {
      return all;
    }
    after = page.next;
  }
}

export type RunsMetrics = { runs: RunMetrics[]; aggregate: RunMetricsAggregate };

/**
 * Metrics of the requested issues, or of every issue with events in the window when `issues` is
 * absent, plus the aggregate over the runs that have events. Requested issues without events stay
 * listed but must not drag the aggregate means down.
 */
export function collectRunsMetrics(
  db: Pick<Db, 'queryEvents'>,
  query: { issues?: number[]; window: { since?: string; until?: string } },
): RunsMetrics {
  const runs: RunMetrics[] = [];
  if (query.issues) {
    for (const n of query.issues) {
      runs.push(computeRunMetrics(n, collectEvents(db, { issue: n, ...query.window })));
    }
  } else {
    const byIssue = new Map<number, EventRecord[]>();
    for (const e of collectEvents(db, query.window)) {
      if (e.issue !== null) {
        const list = byIssue.get(e.issue) ?? [];
        list.push(e);
        byIssue.set(e.issue, list);
      }
    }
    for (const n of [...byIssue.keys()].sort((a, b) => a - b)) {
      runs.push(computeRunMetrics(n, byIssue.get(n) ?? []));
    }
  }
  return { runs, aggregate: aggregateRunMetrics(runs.filter((r) => r.events > 0)) };
}

/** Fixed-width table of the runs and the aggregate, for `dromos run metrics --format table`. */
export function formatMetricsTable(result: RunsMetrics): string {
  const usd = (v: number | null) => (v === null ? '-' : v.toFixed(2));
  const total = result.aggregate;
  const rows: string[][] = [
    ['issue', 'events', 'seconds', 'fix rounds', 'blocked', 'unanswered', 'findings', 'usd'],
    ...result.runs.map((r) => [
      `#${String(r.issue)}`,
      String(r.events),
      String(r.durations.seconds),
      String(r.fixRounds),
      r.blocked ? 'yes' : 'no',
      String(r.unansweredQuestions),
      String(r.findings.total),
      usd(r.usage.usd),
    ]),
    [
      'total',
      String(total.events),
      String(total.durations.seconds),
      String(total.fixRounds),
      String(total.blockedRuns),
      String(total.unansweredQuestions),
      String(result.runs.reduce((n, r) => n + r.findings.total, 0)),
      usd(total.usage.usd),
    ],
  ];
  const widths = (rows[0] ?? []).map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length)));
  const lines = rows.map((r) =>
    r
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd(),
  );
  for (const f of total.repeatedFindings) {
    const where = f.runs.map((n) => `#${String(n)}`).join(', ');
    lines.push(`repeated finding ${f.fingerprint}: ${String(f.count)}x in ${where}`);
  }
  return `${lines.join('\n')}\n`;
}
