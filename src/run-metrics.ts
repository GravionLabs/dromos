import type { Db, EventQuery, EventRecord } from './db.js';
import { MAX_QUERY_LIMIT } from './event-query.js';

export type RunMetrics = {
  issue: number;
  events: number;
  progress: { byKind: Record<string, number> };
  attention: { byKind: Record<string, number> };
  /** Token counts are not tracked per direction: always null. `usd` is never estimated. */
  usage: {
    tokensIn: number | null;
    tokensOut: number | null;
    usd: number | null;
    measured: boolean;
  };
  durations: {
    firstAt: string | null;
    lastAt: string | null;
    seconds: number;
    phases?: Record<string, number>;
  };
  agents: Array<{ agentId: string; role?: string; events: number }>;
};

export type RunMetricsAggregate = {
  runs: number;
  events: number;
  progress: { byKind: Record<string, number> };
  attention: { byKind: Record<string, number> };
  usage: { usd: number | null; measured: boolean };
  durations: { seconds: number };
  mean: { seconds: number; events: number; usd: number | null };
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
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
  if (e.kind !== 'progress' || dataKind(e) !== 'phase' || !isRecord(e.data)) return undefined;
  const fields = e.data.fields;
  return isRecord(fields) && typeof fields.phase === 'string' ? fields.phase : undefined;
}

function chronological(events: readonly EventRecord[]): EventRecord[] {
  return [...events].sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id - b.id,
  );
}

function computeUsd(sorted: readonly EventRecord[]): number | null {
  // Last non-null costUsd sample per agent, summed across agents.
  const lastByAgent = new Map<string, number>();
  for (const e of sorted) {
    if (e.kind !== 'usage' || !isRecord(e.data)) continue;
    const cost = e.data.costUsd;
    if (typeof cost === 'number') lastByAgent.set(e.agentId ?? '', cost);
  }
  if (lastByAgent.size === 0) return null;
  let sum = 0;
  for (const v of lastByAgent.values()) sum += v;
  return sum;
}

export function computeRunMetrics(issue: number, events: readonly EventRecord[]): RunMetrics {
  const sorted = chronological(events);
  const progress: Record<string, number> = {};
  const attention: Record<string, number> = {};
  const agents = new Map<string, { role?: string; events: number }>();

  for (const e of sorted) {
    if (e.kind === 'progress') bump(progress, dataKind(e) ?? 'unspecified');
    else if (e.kind === 'attention') bump(attention, dataKind(e) ?? 'unspecified');
    if (e.agentId !== null) {
      const entry = agents.get(e.agentId) ?? { events: 0 };
      entry.events += 1;
      entry.role = e.role;
      agents.set(e.agentId, entry);
    }
  }

  const firstAt = sorted[0]?.createdAt ?? null;
  const lastAt = sorted[sorted.length - 1]?.createdAt ?? null;
  const lastMs = lastAt === null ? 0 : Date.parse(lastAt);
  const seconds = firstAt === null ? 0 : (lastMs - Date.parse(firstAt)) / 1000;

  const phaseEvents = sorted.filter((e) => phaseName(e) !== undefined);
  const durations: RunMetrics['durations'] = { firstAt, lastAt, seconds };
  if (phaseEvents.length > 0) {
    const phases: Record<string, number> = {};
    phaseEvents.forEach((e, i) => {
      const next = phaseEvents[i + 1];
      const end = next ? Date.parse(next.createdAt) : lastMs;
      bump(phases, phaseName(e) as string, (end - Date.parse(e.createdAt)) / 1000);
    });
    durations.phases = phases;
  }

  const usd = computeUsd(sorted);
  return {
    issue,
    events: sorted.length,
    progress: { byKind: sortedCounts(progress) },
    attention: { byKind: sortedCounts(attention) },
    usage: { tokensIn: null, tokensOut: null, usd, measured: usd !== null },
    durations,
    agents: [...agents.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([agentId, v]) => ({ agentId, role: v.role, events: v.events })),
  };
}

export function aggregateRunMetrics(runs: readonly RunMetrics[]): RunMetricsAggregate {
  const progress: Record<string, number> = {};
  const attention: Record<string, number> = {};
  let events = 0;
  let seconds = 0;
  let usd = 0;
  let measuredRuns = 0;
  for (const r of runs) {
    events += r.events;
    seconds += r.durations.seconds;
    for (const [k, n] of Object.entries(r.progress.byKind)) bump(progress, k, n);
    for (const [k, n] of Object.entries(r.attention.byKind)) bump(attention, k, n);
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
    usage: { usd: measuredRuns > 0 ? usd : null, measured: measuredRuns > 0 },
    durations: { seconds },
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
    if (page.next === null) return all;
    after = page.next;
  }
}
