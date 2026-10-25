import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveLeaseDir, resolveStateDir } from './state-dir.js';

let tmp: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'dromos-state-')));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function initRepo(): string {
  const repo = join(tmp, 'repo');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  return repo;
}

describe('resolveStateDir', () => {
  it('uses an absolute DROMOS_STATE_DIR, trimming trailing separators', async () => {
    const dir = join(tmp, 'state');
    expect(await resolveStateDir('/nowhere', { DROMOS_STATE_DIR: `${dir}/` })).toBe(dir);
  });

  it('resolves a relative DROMOS_STATE_DIR against cwd', async () => {
    expect(await resolveStateDir('/nowhere', { DROMOS_STATE_DIR: 'rel/state' }, tmp)).toBe(
      join(tmp, 'rel', 'state'),
    );
  });

  it('falls back to <git-common-dir>/agents', async () => {
    const repo = initRepo();
    expect(await resolveStateDir(repo, {})).toBe(join(repo, '.git', 'agents'));
  });

  it('errors outside a git repository', async () => {
    const plain = join(tmp, 'plain');
    mkdirSync(plain);
    await expect(resolveStateDir(plain, {})).rejects.toThrow(
      'No state directory: not inside a git repository (set DROMOS_STATE_DIR)',
    );
  });
});

describe('resolveLeaseDir', () => {
  it('creates and returns <state>/leases', async () => {
    const state = join(tmp, 'state');
    const dir = await resolveLeaseDir('/nowhere', { DROMOS_STATE_DIR: state });
    expect(dir).toBe(join(state, 'leases'));
    expect(existsSync(dir)).toBe(true);
  });

  it('is idempotent when leases already exists', async () => {
    const env = { DROMOS_STATE_DIR: join(tmp, 'state') };
    await resolveLeaseDir('/nowhere', env);
    expect(await resolveLeaseDir('/nowhere', env)).toBe(join(tmp, 'state', 'leases'));
  });

  it('refuses a symlinked state dir', async () => {
    const real = join(tmp, 'real');
    mkdirSync(real);
    const link = join(tmp, 'link');
    symlinkSync(real, link);
    await expect(resolveLeaseDir('/nowhere', { DROMOS_STATE_DIR: link })).rejects.toThrow(
      `Refusing symlinked path: ${link}`,
    );
  });

  it('refuses a symlinked leases dir, including a dangling link', async () => {
    const state = join(tmp, 'state');
    mkdirSync(state);
    const leases = join(state, 'leases');
    symlinkSync(join(tmp, 'missing'), leases);
    await expect(resolveLeaseDir('/nowhere', { DROMOS_STATE_DIR: state })).rejects.toThrow(
      `Refusing symlinked path: ${leases}`,
    );
    expect(existsSync(join(tmp, 'missing'))).toBe(false);
  });
});
