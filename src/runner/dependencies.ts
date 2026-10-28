import { appendFileSync, existsSync, symlinkSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { execa } from 'execa';

/**
 * Links the repository's `node_modules` into a fresh worktree so the agent can build and test
 * there. The link is excluded locally: a `node_modules/` ignore rule does not match a symlink.
 * Returns whether a link was made; no `node_modules` in the repository, or one in the worktree, is a no-op.
 */
export async function linkDependencies(repoPath: string, worktreePath: string): Promise<boolean> {
  const source = join(repoPath, 'node_modules');
  const target = join(worktreePath, 'node_modules');
  if (!existsSync(source) || existsSync(target)) return false;
  symlinkSync(source, target, 'dir');
  const res = await execa('git', ['-C', worktreePath, 'rev-parse', '--git-path', 'info/exclude']);
  const path = res.stdout.trim();
  appendFileSync(isAbsolute(path) ? path : join(worktreePath, path), '\n/node_modules\n');
  return true;
}
