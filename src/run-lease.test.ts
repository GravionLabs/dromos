import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LeaseConflictError, leaseFile, leaseKey, stamp } from './lease.js';
import { claimRunLease, releaseRunLease, renewRunLease } from './run-lease.js';

let state: string;
let leaseDir: string;
const WT = '/repo/.worktrees/7';
const claim = (over: Partial<Parameters<typeof claimRunLease>[0]> = {}) =>
  claimRunLease({ repoPath: '/repo', issue: 7, branch: 'agent/7-x', worktreePath: WT, ...over });

function seed(path: string, issue: number, heartbeat: string): string {
  mkdirSync(leaseDir, { recursive: true });
  const file = join(leaseDir, `${leaseKey(path)}.json`);
  writeFileSync(
    file,
    `${JSON.stringify({ path, issue, branch: 'b', host: 'h', started: heartbeat, heartbeat })}\n`,
  );
  return file;
}

beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), 'run-lease-'));
  leaseDir = join(state, 'leases');
  vi.stubEnv('DROMOS_STATE_DIR', state);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(state, { recursive: true, force: true });
});

describe('run lease', () => {
  it('claims a lease with the apm-hub fields', async () => {
    const file = await claim();
    expect(file).toBe(join(leaseDir, `${leaseKey(WT)}.json`));
    const lease = JSON.parse(readFileSync(file, 'utf8'));
    expect(lease).toMatchObject({ path: WT, issue: 7, branch: 'agent/7-x', owner: 'dromos' });
  });

  it('refuses a live lease of the same issue at another path', async () => {
    seed('/other/.worktrees/7', 7, stamp());
    await expect(claim()).rejects.toBeInstanceOf(LeaseConflictError);
    expect(existsSync(leaseFile(leaseDir, WT))).toBe(false);
  });

  it('drops a stale lease of the same issue at another path and keeps unrelated ones', async () => {
    const old = seed('/other/.worktrees/7', 7, '2020-01-01T00:00:00Z');
    const unrelated = seed('/other/.worktrees/9', 9, '2020-01-01T00:00:00Z');
    await claim();
    expect(existsSync(old)).toBe(false);
    expect(existsSync(unrelated)).toBe(true);
    expect(existsSync(leaseFile(leaseDir, WT))).toBe(true);
  });

  it('renews the heartbeat of a claimed lease', async () => {
    const file = await claim();
    const old = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, `${JSON.stringify({ ...old, heartbeat: '2020-01-01T00:00:00Z' })}\n`);
    await renewRunLease({ repoPath: '/repo', worktreePath: WT });
    expect(JSON.parse(readFileSync(file, 'utf8')).heartbeat).not.toBe('2020-01-01T00:00:00Z');
  });

  it('releases the lease and tolerates a missing one', async () => {
    const file = await claim();
    await releaseRunLease({ repoPath: '/repo', worktreePath: WT });
    expect(existsSync(file)).toBe(false);
    await expect(releaseRunLease({ repoPath: '/repo', worktreePath: WT })).resolves.toBeUndefined();
  });

  it('reports instead of throwing when the lease dir is unusable', async () => {
    const msgs: string[] = [];
    // a state dir that is a file makes mkdir of leases fail
    writeFileSync(join(state, 'blocker'), '');
    vi.stubEnv('DROMOS_STATE_DIR', join(state, 'blocker'));
    await releaseRunLease({ repoPath: '/repo', worktreePath: WT }, (m) => msgs.push(m));
    await renewRunLease({ repoPath: '/repo', worktreePath: WT }, (m) => msgs.push(m));
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toContain('lease release failed');
    expect(msgs[1]).toContain('lease renew failed');
  });
});
