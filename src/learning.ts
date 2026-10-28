import type { Db, EventRecord } from './db.js';
import { collectEvents } from './run-metrics.js';

/** Repository key of events stored without one. */
export const UNKNOWN_REPO = 'unknown';

export type FingerprintLearning = {
  fingerprint: string;
  count: number;
  /** Distinct `repo#issue` runs that reported it. */
  runs: string[];
  repos: Record<string, number>;
};

export type CauseLearning = {
  /** Attempt cause (`initial`, `gate_failed`, `sent_back`) or fix round cause (`review_findings`). */
  cause: string;
  count: number;
  repos: Record<string, number>;
};

export type Learning = { fingerprints: FingerprintLearning[]; causes: CauseLearning[] };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const byCountThenKey = <T extends { count: number }>(a: T, b: T, ka: string, kb: string): number =>
  b.count - a.count || (ka < kb ? -1 : ka > kb ? 1 : 0);

/**
 * Review finding fingerprints (`outcome.finding`) and retry causes (`attempt.started`,
 * `outcome.fixRound`) over all repositories in the window, or over `repo` only. Most frequent first.
 */
export function collectLearning(
  db: Pick<Db, 'queryEvents'>,
  query: { repo?: string; since?: string; until?: string },
): Learning {
  const fingerprints = new Map<string, FingerprintLearning>();
  const causes = new Map<string, CauseLearning>();
  const bump = (repos: Record<string, number>, repo: string): void => {
    repos[repo] = (repos[repo] ?? 0) + 1;
  };
  const events: EventRecord[] = collectEvents(db, {
    ...query,
    types: ['outcome.finding', 'attempt.started', 'outcome.fixRound'],
  });
  for (const e of events) {
    const d = isRecord(e.data) ? e.data : {};
    const repo = e.repo ?? UNKNOWN_REPO;
    if (e.kind === 'outcome.finding' && typeof d.fingerprint === 'string') {
      const entry = fingerprints.get(d.fingerprint) ?? {
        fingerprint: d.fingerprint,
        count: 0,
        runs: [],
        repos: Object.create(null) as Record<string, number>,
      };
      entry.count += 1;
      const run = `${repo}#${String(e.issue ?? 0)}`;
      if (!entry.runs.includes(run)) entry.runs.push(run);
      bump(entry.repos, repo);
      fingerprints.set(d.fingerprint, entry);
    } else if (typeof d.cause === 'string') {
      const entry = causes.get(d.cause) ?? {
        cause: d.cause,
        count: 0,
        repos: Object.create(null) as Record<string, number>,
      };
      entry.count += 1;
      bump(entry.repos, repo);
      causes.set(d.cause, entry);
    }
  }
  return {
    fingerprints: [...fingerprints.values()].sort((a, b) =>
      byCountThenKey(a, b, a.fingerprint, b.fingerprint),
    ),
    causes: [...causes.values()].sort((a, b) => byCountThenKey(a, b, a.cause, b.cause)),
  };
}
