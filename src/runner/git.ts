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

/** The remote has no `release/next` and the repository config names no `base`. */
export class MissingIntegrationBranchError extends Error {
  override name = 'MissingIntegrationBranchError';
  constructor() {
    super(
      `no integration branch \`${PREFERRED_BASE}\` on origin; cut it with \`github-release cut\` or set "base" in .dromos/config.json`,
    );
  }
}

/**
 * `release/next` when the remote has it, else the configured `base`. Without both the run must not
 * fall back to the default branch: its pull request would bypass the release flow.
 */
export async function integrationBranch(repoPath: string, base?: string): Promise<string> {
  const preferred = await execa(
    'git',
    ['-C', repoPath, 'ls-remote', '--exit-code', '--heads', 'origin', PREFERRED_BASE],
    { reject: false },
  );
  if (preferred.exitCode === 0) return PREFERRED_BASE;
  if (base !== undefined) return base;
  throw new MissingIntegrationBranchError();
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
  configuredBase?: string,
): Promise<RunWorktree> {
  const path = join(repoPath, WORKTREE_DIR, String(issue));
  const branch = runBranchName(type, issue, title);
  const base = await integrationBranch(repoPath, configuredBase);
  await assertWorktreeDirIgnored(repoPath, WORKTREE_DIR);
  await createWorktree(repoPath, base, branch, path, () => ensureWorktreeParent(repoPath, path));
  return { path, branch, base };
}

/** Publishes the run branch: `gh pr create` needs it on the remote. */
export async function pushRunBranch(worktree: RunWorktree): Promise<void> {
  await execa('git', ['-C', worktree.path, 'push', '--set-upstream', 'origin', worktree.branch]);
}

/**
 * What a run leaves behind. `pr_opened` removes the worktree and the local branch (the branch lives
 * on in the pull request). `blocked` keeps both for the next look. `failed` (setup failure, error
 * path) removes both when the branch has no commit over the integration branch, else keeps them like
 * `blocked`. Resolves to whether the worktree was removed.
 */
export async function finishRunWorktree(
  repoPath: string,
  worktree: RunWorktree,
  outcome: 'pr_opened' | 'blocked' | 'failed',
): Promise<boolean> {
  if (outcome === 'blocked') return false;
  if (outcome === 'failed') {
    const count = await execa(
      'git',
      ['-C', worktree.path, 'rev-list', '--count', `origin/${worktree.base}..HEAD`],
      { reject: false },
    );
    const commits = Number(String(count.stdout ?? '').trim());
    if (count.exitCode !== 0 || !Number.isInteger(commits) || commits > 0) return false;
  }
  await execa('git', ['-C', repoPath, 'worktree', 'remove', '--force', '--', worktree.path]);
  await execa('git', ['-C', repoPath, 'branch', '-D', '--', worktree.branch]);
  return true;
}

/** Where a kept worktree is and how to go on: `--resume` continues it, `--restart` discards it. */
export function keptWorktreeHint(issue: number, worktree: RunWorktree): string {
  const nr = String(issue);
  return `worktree ${worktree.path} and branch ${worktree.branch} kept; continue with \`dromos run pbi ${nr} --resume\` or discard with \`dromos run pbi ${nr} --restart\``;
}
