// Run-level wrappers around the apm-hub compatible checkout leases.
import { rmSync } from 'node:fs';
import {
  claimLease,
  isLive,
  LEASE_TTL_MINUTES,
  readLeases,
  releaseLease,
  renewLease,
} from './lease.js';
import { resolveLeaseDir } from './state-dir.js';

export type RunLeaseClaim = {
  repoPath: string;
  issue: number;
  branch: string;
  worktreePath: string;
};

export type RunLeaseRef = { repoPath: string; worktreePath: string };

type OnError = (message: string) => void;

function reason(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Claims the lease; throws LeaseConflictError when a live lease holds the path or the issue. */
export async function claimRunLease(req: RunLeaseClaim): Promise<string> {
  const leaseDir = await resolveLeaseDir(req.repoPath);
  const file = await claimLease(leaseDir, {
    path: req.worktreePath,
    issue: req.issue,
    branch: req.branch,
  });
  // claimLease leaves stale leases of the same issue at another path in place: drop them
  try {
    for (const entry of readLeases(leaseDir)) {
      if (
        entry.file !== file &&
        String(entry.lease.issue) === String(req.issue) &&
        !isLive(entry.lease, new Date(), LEASE_TTL_MINUTES)
      ) {
        rmSync(entry.file, { force: true });
      }
    }
  } catch {
    // best effort: the claim itself succeeded
  }
  return file;
}

/** Refreshes the heartbeat; never throws. */
export async function renewRunLease(run: RunLeaseRef, onError?: OnError): Promise<void> {
  try {
    const leaseDir = await resolveLeaseDir(run.repoPath);
    renewLease(leaseDir, run.worktreePath);
  } catch (e) {
    onError?.(`lease renew failed for ${run.worktreePath}: ${reason(e)}`);
  }
}

/** Removes the lease; never throws. */
export async function releaseRunLease(run: RunLeaseRef, onError?: OnError): Promise<void> {
  try {
    const leaseDir = await resolveLeaseDir(run.repoPath);
    releaseLease(leaseDir, run.worktreePath);
  } catch (e) {
    onError?.(`lease release failed for ${run.worktreePath}: ${reason(e)}`);
  }
}
