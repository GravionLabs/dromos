import { join } from 'node:path';
import { execa } from 'execa';
import {
  assertWorktreeDirIgnored,
  createWorktree,
  ensureWorktreeParent,
  isSafeBranchName,
  slugify,
} from '../worktree.js';

export const WORKTREE_DIR = '.worktrees';
const PREFERRED_BASE = 'release/next';

export type BranchType = 'feat' | 'fix' | 'chore' | 'docs' | 'ci';

export interface RunWorktree {
  path: string;
  branch: string;
  /** The integration branch the branch was cut from and the pull request targets. */
  base: string;
}

/** `release/next` when the remote has it, else the remote's default branch. */
export async function integrationBranch(repoPath: string): Promise<string> {
  const preferred = await execa(
    'git',
    ['-C', repoPath, 'ls-remote', '--exit-code', '--heads', 'origin', PREFERRED_BASE],
    { reject: false },
  );
  if (preferred.exitCode === 0) return PREFERRED_BASE;
  const head = await execa(
    'git',
    ['-C', repoPath, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
    {
      reject: false,
    },
  );
  const name = String(head.stdout ?? '')
    .trim()
    .replace(/^origin\//, '');
  return head.exitCode === 0 && name !== '' ? name : 'main';
}

export function runBranchName(type: BranchType, issue: number, title: string): string {
  const branch = `${type}/${String(issue)}-${slugify(title) || 'task'}`;
  if (!isSafeBranchName(branch)) throw new Error(`invalid branch name: ${branch}`);
  return branch;
}

/** Creates `<repo>/.worktrees/<nr>` on a new branch cut from the integration branch. */
export async function openRunWorktree(
  repoPath: string,
  issue: number,
  type: BranchType,
  title: string,
): Promise<RunWorktree> {
  const path = join(repoPath, WORKTREE_DIR, String(issue));
  const branch = runBranchName(type, issue, title);
  const base = await integrationBranch(repoPath);
  await assertWorktreeDirIgnored(repoPath, WORKTREE_DIR);
  await createWorktree(repoPath, base, branch, path, () => ensureWorktreeParent(repoPath, path));
  return { path, branch, base };
}

/** Publishes the run branch: `gh pr create` needs it on the remote. */
export async function pushRunBranch(worktree: RunWorktree): Promise<void> {
  await execa('git', ['-C', worktree.path, 'push', '--set-upstream', 'origin', worktree.branch]);
}

/** `pr_opened` removes the worktree (the branch lives on in the PR); `blocked` keeps it for the next look. */
export async function finishRunWorktree(
  repoPath: string,
  worktree: RunWorktree,
  outcome: 'pr_opened' | 'blocked',
): Promise<boolean> {
  if (outcome === 'blocked') return false;
  await execa('git', ['-C', repoPath, 'worktree', 'remove', '--force', '--', worktree.path]);
  return true;
}
