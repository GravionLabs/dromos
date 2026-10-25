import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LeaseConflictError, leaseFile, leaseKey, stamp } from './lease.js';
import {
  afterRunTransition,
  claimRunLease,
  releaseRunLease,
  renewActiveRunLeases,
  renewRunLease,
  startLeaseRenewal,
} from './run-lease.js';
import type { RunState } from './schemas.js';

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

const OLD = '2020-01-01T00:00:00Z';
const heartbeatOf = (file: string) => JSON.parse(readFileSync(file, 'utf8')).heartbeat;
const age = (file: string) => {
  const old = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, `${JSON.stringify({ ...old, heartbeat: OLD })}\n`);
};
const ref = (state: RunState, worktreePath = WT) => ({ repoPath: '/repo', worktreePath, state });

describe('afterRunTransition', () => {
  it.each(['implementing', 'gating', 'reviewing', 'approved'] as const)(
    'renews the heartbeat in state %s',
    async (state) => {
      const file = await claim();
      age(file);
      await afterRunTransition({ log: { logLine: vi.fn() } }, ref(state));
      expect(heartbeatOf(file)).not.toBe(OLD);
    },
  );

  it.each(['blocked', 'pr_opened'] as const)('releases the lease in state %s', async (state) => {
    const file = await claim();
    await afterRunTransition({ log: { logLine: vi.fn() } }, ref(state));
    expect(existsSync(file)).toBe(false);
  });

  it('does not create a lease when none exists', async () => {
    await afterRunTransition({ log: { logLine: vi.fn() } }, ref('implementing'));
    expect(existsSync(leaseFile(leaseDir, WT))).toBe(false);
  });

  it('logs an I/O error and does not throw, even when the log throws', async () => {
    writeFileSync(join(state, 'blocker'), '');
    vi.stubEnv('DROMOS_STATE_DIR', join(state, 'blocker'));
    const logLine = vi.fn();
    await afterRunTransition({ log: { logLine } }, ref('blocked'));
    expect(logLine).toHaveBeenCalledWith('ERROR', expect.stringContaining('lease release failed'));
    const broken = {
      logLine: () => {
        throw new Error('log down');
      },
    };
    await expect(afterRunTransition({ log: broken }, ref('implementing'))).resolves.toBeUndefined();
  });
});

describe('lease renewal timer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  const runs = (...r: ReturnType<typeof ref>[]) => ({ listRuns: () => r });
  const A = '/repo/.worktrees/1';
  const B = '/repo/.worktrees/2';
  const C = '/repo/.worktrees/3';

  it('renews non-terminal runs only', async () => {
    const a = await claim({ issue: 1, worktreePath: A });
    const b = await claim({ issue: 2, worktreePath: B });
    age(a);
    age(b);
    await renewActiveRunLeases(runs(ref('implementing', A), ref('blocked', B)), {
      logLine: vi.fn(),
    });
    expect(heartbeatOf(a)).not.toBe(OLD);
    expect(heartbeatOf(b)).toBe(OLD);
  });

  it('renews once at start and then every 30 minutes', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const a = await claim({ issue: 1, worktreePath: A });
    age(a);
    const stop = await startLeaseRenewal(runs(ref('reviewing', A)), { logLine: vi.fn() });
    expect(heartbeatOf(a)).not.toBe(OLD); // at start
    age(a);
    await vi.advanceTimersByTimeAsync(29 * 60_000);
    expect(heartbeatOf(a)).toBe(OLD);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(heartbeatOf(a)).not.toBe(OLD);
    stop();
    age(a);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(heartbeatOf(a)).toBe(OLD);
  });

  it('uses an unref timer', async () => {
    const spy = vi.spyOn(globalThis, 'setInterval');
    const stop = await startLeaseRenewal(runs(), { logLine: vi.fn() });
    const timer = spy.mock.results[0]?.value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
    stop();
    spy.mockRestore();
  });

  it('logs a failing sweep and keeps going', async () => {
    const logLine = vi.fn();
    const db = {
      listRuns: () => {
        throw new Error('db closed');
      },
    };
    await expect(renewActiveRunLeases(db, { logLine })).resolves.toBeUndefined();
    expect(logLine).toHaveBeenCalledWith('ERROR', expect.stringContaining('db closed'));
    await renewActiveRunLeases(runs(ref('implementing', C)), { logLine });
  });
});
