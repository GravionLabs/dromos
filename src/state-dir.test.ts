import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveStateDir } from './state-dir.js';

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
