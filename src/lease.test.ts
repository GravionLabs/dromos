import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  claimLease,
  isLive,
  type Lease,
  LeaseConflictError,
  leaseFile,
  leaseKey,
  readLeases,
  releaseLease,
  renewLease,
  stamp,
} from './lease.js';

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return { ...real, renameSync: vi.fn(real.renameSync), writeSync: vi.fn(real.writeSync) };
});

const NOW = new Date('2026-10-25T12:00:00Z');
const at = () => NOW;
const CHECKOUT = '/tmp/repo/.worktrees/126';

let dir: string;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'dromos-lease-')));
});
afterEach(() => {
  vi.mocked(fs.renameSync).mockClear();
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeApmHubLease(path: string, issue: number, heartbeat: string): string {
  // byte layout of apm-hub `ConvertTo-Json -Compress` + "`n"
  const file = join(dir, `${leaseKey(path)}.json`);
  fs.writeFileSync(
    file,
    `{"path":"${path}","issue":${issue},"branch":"feat/x","host":"other","started":"${heartbeat}","heartbeat":"${heartbeat}"}\n`,
  );
  return file;
}

function makeOld(file: string) {
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(file, old, old);
}

function leftovers(): string[] {
  return fs.readdirSync(dir).filter((n) => n.endsWith('.stale') || n.endsWith('.tmp'));
}

describe('leaseKey / stamp / isLive', () => {
  it('matches the apm-hub Get-LeaseKey vector', () => {
    expect(leaseKey('/tmp/repo/.worktrees/126')).toBe('27b8dbc4754c6e12');
  });

  it('formats UTC stamps without millis', () => {
    expect(stamp(new Date('2026-01-02T03:04:05.678Z'))).toBe('2026-01-02T03:04:05Z');
  });

  it('is live below 120 minutes heartbeat age, stale at or above', () => {
    const l = (heartbeat: string): Lease => ({
      path: 'p',
      issue: 1,
      branch: 'b',
      host: 'h',
      started: heartbeat,
      heartbeat,
    });
    expect(isLive(l('2026-10-25T10:00:01Z'), NOW)).toBe(true);
    expect(isLive(l('2026-10-25T10:00:00Z'), NOW)).toBe(false);
    expect(isLive(l('garbage'), NOW)).toBe(false);
  });
});

describe('claimLease', () => {
  it('writes the apm-hub byte layout with owner last', async () => {
    const file = await claimLease(
      dir,
      { path: CHECKOUT, issue: 126, branch: 'feat/x' },
      {
        now: at,
        host: 'mac',
      },
    );
    expect(file).toBe(join(dir, '27b8dbc4754c6e12.json'));
    expect(fs.readFileSync(file).toString('hex').startsWith('efbbbf')).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe(
      '{"path":"/tmp/repo/.worktrees/126","issue":126,"branch":"feat/x","host":"mac","started":"2026-10-25T12:00:00Z","heartbeat":"2026-10-25T12:00:00Z","owner":"dromos"}\n',
    );
    expect(leftovers()).toEqual([]);
  });

  it('lets exactly one of two concurrent claims win', async () => {
    const req = { path: CHECKOUT, issue: 126, branch: 'feat/x' };
    const results = await Promise.allSettled([claimLease(dir, req), claimLease(dir, req)]);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toBeInstanceOf(LeaseConflictError);
    expect(fs.readdirSync(dir)).toEqual(['27b8dbc4754c6e12.json']);
  });

  it('treats a young unreadable file as a concurrent claimer and never deletes it', async () => {
    const file = leaseFile(dir, CHECKOUT);
    fs.writeFileSync(file, '');
    await expect(
      claimLease(dir, { path: CHECKOUT, issue: 126, branch: 'feat/x' }),
    ).rejects.toBeInstanceOf(LeaseConflictError);
    expect(fs.readFileSync(file, 'utf8')).toBe('');
    expect(leftovers()).toEqual([]);
  });

  it('refuses a foreign live lease on the same path', async () => {
    const file = writeApmHubLease(CHECKOUT, 99, '2026-10-25T11:00:00Z');
    const err = await claimLease(
      dir,
      { path: `${CHECKOUT}/`, issue: 126, branch: 'b' },
      {
        now: at,
      },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LeaseConflictError);
    expect((err as Error).message).toContain('#99');
    expect(fs.readFileSync(file, 'utf8')).toContain('"issue":99');
  });

  it('refuses a live lease of the same issue on another path', async () => {
    writeApmHubLease('/tmp/repo', 126, '2026-10-25T11:00:00Z');
    await expect(
      claimLease(dir, { path: CHECKOUT, issue: 126, branch: 'b' }, { now: at }),
    ).rejects.toBeInstanceOf(LeaseConflictError);
    expect(fs.existsSync(leaseFile(dir, CHECKOUT))).toBe(false);
  });

  it('takes over a stale lease (heartbeat 121 min old)', async () => {
    const file = writeApmHubLease(CHECKOUT, 99, '2026-10-25T09:59:00Z');
    const claimed = await claimLease(dir, { path: CHECKOUT, issue: 126, branch: 'b' }, { now: at });
    expect(claimed).toBe(file);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({
      issue: 126,
      owner: 'dromos',
    });
    expect(leftovers()).toEqual([]);
  });

  it('takes over an old unreadable lease file', async () => {
    const file = leaseFile(dir, CHECKOUT);
    fs.writeFileSync(file, '{not json');
    makeOld(file);
    await claimLease(dir, { path: CHECKOUT, issue: 126, branch: 'b' }, { now: at });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ issue: 126 });
    expect(leftovers()).toEqual([]);
  });

  it('puts back a lease that changed during takeover', async () => {
    const file = writeApmHubLease(CHECKOUT, 99, '2026-10-25T09:00:00Z');
    const renewed =
      '{"path":"/tmp/repo/.worktrees/126","issue":99,"branch":"feat/x","host":"other","started":"2026-10-25T09:00:00Z","heartbeat":"2026-10-25T11:59:00Z"}\n';
    const real = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.mocked(fs.renameSync).mockImplementationOnce((from, to) => {
      real.writeFileSync(file, renewed); // apm-hub renews between our read and our move
      real.renameSync(from, to);
    });
    await expect(
      claimLease(dir, { path: CHECKOUT, issue: 126, branch: 'b' }, { now: at }),
    ).rejects.toBeInstanceOf(LeaseConflictError);
    expect(fs.readFileSync(file, 'utf8')).toBe(renewed);
    expect(leftovers()).toEqual([]);
  });

  it('retries when another taker already moved the stale file', async () => {
    const file = writeApmHubLease(CHECKOUT, 99, '2026-10-25T09:00:00Z');
    vi.mocked(fs.renameSync).mockImplementationOnce(() => {
      fs.rmSync(file);
      throw Object.assign(new Error('gone'), { code: 'ENOENT' });
    });
    await claimLease(dir, { path: CHECKOUT, issue: 126, branch: 'b' }, { now: at });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ issue: 126 });
  });

  it('removes its own file when writing fails after the exclusive create', async () => {
    vi.mocked(fs.writeSync).mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    await expect(claimLease(dir, { path: CHECKOUT, issue: 126, branch: 'b' })).rejects.toThrow(
      'disk full',
    );
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('refuses a symlinked lease file', async () => {
    const target = join(dir, 'target');
    fs.writeFileSync(target, '');
    fs.symlinkSync(target, leaseFile(dir, CHECKOUT));
    await expect(claimLease(dir, { path: CHECKOUT, issue: 126, branch: 'b' })).rejects.toThrow(
      'Refusing symlinked path',
    );
  });
});

describe('readLeases', () => {
  it('returns parsable leases with liveness and skips unparsable ones', () => {
    writeApmHubLease(CHECKOUT, 126, '2026-10-25T11:00:00Z');
    writeApmHubLease('/tmp/repo', 5, '2026-10-25T01:00:00Z');
    fs.writeFileSync(join(dir, 'broken.json'), 'nope');
    fs.writeFileSync(join(dir, 'other.txt'), '{}');
    const got = readLeases(dir, NOW)
      .map((l) => [l.lease.issue, l.live])
      .sort();
    expect(got).toEqual([
      [126, true],
      [5, false],
    ]);
  });

  it('returns nothing for an empty directory', () => {
    expect(readLeases(dir, NOW)).toEqual([]);
  });

  it('throws on a symlinked lease file', () => {
    fs.symlinkSync(join(dir, 'nowhere'), join(dir, 'x.json'));
    expect(() => readLeases(dir, NOW)).toThrow('Refusing symlinked path');
  });
});

describe('renewLease', () => {
  it('updates heartbeat only, keeping started and owner, atomically', async () => {
    const file = await claimLease(
      dir,
      { path: CHECKOUT, issue: 126, branch: 'b' },
      {
        now: at,
        host: 'mac',
      },
    );
    vi.mocked(fs.renameSync).mockClear();
    expect(renewLease(dir, CHECKOUT, new Date('2026-10-25T12:30:00Z'))).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe(
      '{"path":"/tmp/repo/.worktrees/126","issue":126,"branch":"b","host":"mac","started":"2026-10-25T12:00:00Z","heartbeat":"2026-10-25T12:30:00Z","owner":"dromos"}\n',
    );
    expect(vi.mocked(fs.renameSync)).toHaveBeenCalledWith(`${file}.${process.pid}.tmp`, file);
    expect(leftovers()).toEqual([]);
  });

  it('is a no-op returning false for a missing lease', () => {
    expect(renewLease(dir, CHECKOUT, NOW)).toBe(false);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('refuses a symlinked lease file or tmp path', async () => {
    const file = await claimLease(dir, { path: CHECKOUT, issue: 126, branch: 'b' });
    fs.symlinkSync(join(dir, 'elsewhere'), `${file}.${process.pid}.tmp`);
    expect(() => renewLease(dir, CHECKOUT)).toThrow('Refusing symlinked path');
    fs.rmSync(`${file}.${process.pid}.tmp`);
    fs.rmSync(file);
    fs.symlinkSync(join(dir, 'elsewhere'), file);
    expect(() => renewLease(dir, CHECKOUT)).toThrow('Refusing symlinked path');
  });
});

describe('releaseLease', () => {
  it('removes the lease file and is idempotent', async () => {
    const file = await claimLease(dir, { path: CHECKOUT, issue: 126, branch: 'b' });
    releaseLease(dir, CHECKOUT);
    expect(fs.existsSync(file)).toBe(false);
    expect(() => releaseLease(dir, CHECKOUT)).not.toThrow();
  });
});
