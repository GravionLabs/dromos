import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative } from 'node:path';
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
  const detail = String(res.stderr || res.shortMessage || '').trim();
  throw new Error(
    `git check-ignore failed in ${repoPath} (exit code ${String(res.exitCode)})${detail ? `: ${detail}` : ''}`,
  );
}

/** Creates the worktree parent dir and refuses when it resolves (symlinks) outside the repository. */
export function ensureWorktreeParent(repoPath: string, worktreePath: string): void {
  const parent = dirname(worktreePath);
  mkdirSync(parent, { recursive: true });
  const rel = relative(realpathSync(repoPath), realpathSync(parent));
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`worktree directory ${parent} resolves outside the repository ${repoPath}`);
  }
}

export async function createWorktree(
  repoPath: string,
  baseBranch: string,
  branch: string,
  worktreePath: string,
  prepare?: () => void,
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
  prepare?.();
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
