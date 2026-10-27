// Run-level wrappers around the apm-hub compatible checkout leases.
import { claimLease, releaseLease, renewLease } from './lease.js';
import type { RunState } from './schemas.js';
import { resolveLeaseDir } from './state-dir.js';

export type RunLeaseClaim = {
  repoPath: string;
  issue: number;
  branch: string;
  worktreePath: string;
};

export type RunLeaseRef = { repoPath: string; worktreePath: string; issueNumber: number };

function isTerminal(state: RunState): boolean {
  return state === 'pr_opened' || state === 'blocked';
}

type OnError = (message: string) => void;

function reason(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Claims the lease; throws LeaseConflictError when a live lease holds the path or the issue. */
export async function claimRunLease(req: RunLeaseClaim): Promise<string> {
  const leaseDir = await resolveLeaseDir(req.repoPath);
  return claimLease(leaseDir, {
    path: req.worktreePath,
    issue: req.issue,
    branch: req.branch,
  });
}

/** Refreshes the heartbeat; never throws. */
export async function renewRunLease(run: RunLeaseRef, onError?: OnError): Promise<void> {
  try {
    const leaseDir = await resolveLeaseDir(run.repoPath);
    renewLease(leaseDir, run.worktreePath, undefined, run.issueNumber);
  } catch (e) {
    onError?.(`lease renew failed for ${run.worktreePath}: ${reason(e)}`);
  }
}

/** Removes the lease; never throws. */
export async function releaseRunLease(run: RunLeaseRef, onError?: OnError): Promise<void> {
  try {
    const leaseDir = await resolveLeaseDir(run.repoPath);
    releaseLease(leaseDir, run.worktreePath, run.issueNumber);
  } catch (e) {
    onError?.(`lease release failed for ${run.worktreePath}: ${reason(e)}`);
  }
}

export type LeaseLog = { logLine(kind: 'ERROR', text: string): void };
export type RunLeaseState = RunLeaseRef & { state: RunState };

/**
 * Call after a run state change is committed (outside any transaction): a terminal state
 * releases the lease, any other state renews its heartbeat. Failures are logged, never thrown.
 */
export async function afterRunTransition(
  ctx: { log: LeaseLog },
  run: RunLeaseState,
): Promise<void> {
  const onError: OnError = (message) => {
    try {
      ctx.log.logLine('ERROR', message);
    } catch {
      // logging is best effort
    }
  };
  if (isTerminal(run.state)) await releaseRunLease(run, onError);
  else await renewRunLease(run, onError);
}

export const LEASE_RENEW_INTERVAL_MS = 30 * 60_000;

type RunSource = { listRuns(): RunLeaseState[] };

/** Renews the lease of every non-terminal run; never throws. */
export async function renewActiveRunLeases(
  db: RunSource,
  log: LeaseLog,
  isStopped: () => boolean = () => false,
): Promise<void> {
  try {
    for (const run of db.listRuns()) {
      if (isStopped()) return;
      if (!isTerminal(run.state)) await renewRunLease(run, (m) => log.logLine('ERROR', m));
    }
  } catch (e) {
    try {
      log.logLine('ERROR', `lease renewal sweep failed: ${reason(e)}`);
    } catch {
      // logging is best effort
    }
  }
}

/** Renews now and then every 30 min on an unref'd timer; returns the stop function. */
export async function startLeaseRenewal(
  db: RunSource,
  log: LeaseLog,
  intervalMs: number = LEASE_RENEW_INTERVAL_MS,
): Promise<() => void> {
  let stopped = false;
  let sweeping = false;
  const sweep = async () => {
    if (stopped || sweeping) return; // no overlapping sweeps, none after close
    sweeping = true;
    try {
      await renewActiveRunLeases(db, log, () => stopped);
    } finally {
      sweeping = false;
    }
  };
  const timer = setInterval(() => void sweep(), intervalMs);
  timer.unref();
  await sweep();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
