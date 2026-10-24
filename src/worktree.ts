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

/** Refuses unless `<worktreeDir>/` is git-ignored in the repository (dromos never edits tracked files). */
export async function assertWorktreeDirIgnored(
  repoPath: string,
  worktreeDir: string,
): Promise<void> {
  const res = await execa(
    'git',
    ['-C', repoPath, 'check-ignore', '-q', '--', `${worktreeDir}/probe`],
    {
      reject: false,
    },
  );
  if (res.exitCode === 0) return;
  if (res.exitCode === 1) {
    throw new Error(
      `worktree directory '${worktreeDir}' is not git-ignored in ${repoPath}; add '${worktreeDir}/' to .gitignore (apm-hub: Enable-Worktrees.ps1)`,
    );
  }
  throw new Error(`git check-ignore failed in ${repoPath} (exit code ${String(res.exitCode)})`);
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
