import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigSchema } from './config.js';
import { openDb } from './db.js';
import { startHttp } from './http.js';
import { claimLease, leaseFile } from './lease.js';

const OLD = '2020-01-01T00:00:00Z';

describe('lease renewal in the server', () => {
  let state: string;
  let dataDir: string;
  const file = () => leaseFile(join(state, 'leases'), '/wt');
  const heartbeat = () => JSON.parse(readFileSync(file(), 'utf8')).heartbeat;
  const age = () => {
    const lease = JSON.parse(readFileSync(file(), 'utf8'));
    writeFileSync(file(), `${JSON.stringify({ ...lease, heartbeat: OLD })}\n`);
  };

  beforeEach(() => {
    state = mkdtempSync(join(tmpdir(), 'http-lease-'));
    dataDir = mkdtempSync(join(tmpdir(), 'http-lease-data-'));
    vi.stubEnv('DROMOS_STATE_DIR', state);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    rmSync(state, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('renews active run leases at start and every 30 minutes until close', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const db = openDb(':memory:');
    db.insertRun({
      id: 'run-1-1',
      repo: 'o/r',
      repoPath: '/repo',
      issueNumber: 1,
      issueTitle: 'T',
      baseBranch: 'main',
      branch: 'agent/1-t',
      worktreePath: '/wt',
      state: 'implementing',
      round: 1,
    });
    mkdirSync(join(state, 'leases'));
    await claimLease(join(state, 'leases'), { path: '/wt', issue: 1, branch: 'agent/1-t' });
    age();
    const http = await startHttp({ config: ConfigSchema.parse({ port: 0, dataDir }), db });
    expect(heartbeat()).not.toBe(OLD);
    age();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(heartbeat()).not.toBe(OLD);
    await http.close();
    age();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(heartbeat()).toBe(OLD);
    db.close();
  });
});
