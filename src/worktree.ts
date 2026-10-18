import { existsSync } from 'node:fs';
import { execa } from 'execa';

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 40)
    .replace(/^-+|-+$/g, '');
}

/** Conservative branch-name check: no leading dash (option injection), no `..`, no odd characters. */
export function isSafeBranchName(name: string): boolean {
  return (
    /^[A-Za-z0-9._/-]+$/.test(name) &&
    !name.startsWith('-') &&
    !name.includes('..') &&
    !name.endsWith('/') &&
    !name.endsWith('.lock')
  );
}

export async function createWorktree(
  repoPath: string,
  baseBranch: string,
  branch: string,
  worktreePath: string,
): Promise<void> {
  if (!isSafeBranchName(baseBranch)) {
    throw new Error(`invalid base branch name: ${baseBranch}`);
  }
  if (existsSync(worktreePath)) {
    throw new Error(`worktree path already exists: ${worktreePath}`);
  }
  const check = await execa(
    'git',
    ['-C', repoPath, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
    { reject: false },
  );
  if (check.exitCode === 0) {
    throw new Error(`branch already exists: ${branch}`);
  }
  await execa('git', ['-C', repoPath, 'fetch', '--', 'origin', baseBranch]);
  await execa('git', [
    '-C',
    repoPath,
    'worktree',
    'add',
    '-b',
    branch,
    '--',
    worktreePath,
    `origin/${baseBranch}`,
  ]);
}
