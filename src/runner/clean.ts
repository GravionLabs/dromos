import { basename } from 'node:path';
import { execa } from 'execa';
import { WORKTREE_DIR } from './git.js';

/**
 * `dromos run clean [<nr>] [--dry-run]`: removes the worktrees and local branches of finished
 * issues (the issue is closed, or the pull request of the branch is merged or closed) and prunes
 * stale worktree registrations. A worktree with uncommitted changes, a branch checked out
 * elsewhere and anything whose issue or pull request is still open is skipped and listed.
 */

export interface CleanPr {
  number: number;
  state: string;
}

/** Everything that touches git or `gh`; replaced in unit tests. */
export interface CleanOps {
  /** Runs `git` in `cwd` (default: the repository); never rejects on a non-zero exit. */
  git: (args: string[], cwd?: string) => Promise<{ exitCode: number; stdout: string }>;
  /** `OPEN` or `CLOSED`. */
  issueState: (issue: number) => Promise<string>;
  /** Pull requests (any state) whose head is `branch`. */
  prs: (branch: string) => Promise<CleanPr[]>;
}

export interface CleanInput {
  repo: string;
  /** Only this issue; every issue with a worktree or run branch when omitted. */
  issue?: number;
  /** Report only: nothing is removed or pruned. */
  dryRun?: boolean;
  ops?: Partial<CleanOps>;
}

export interface CleanResult {
  /** Stale worktree registrations pruned (or that would be). */
  pruned: string[];
  /** Worktrees (`.worktrees/<nr>`) and branches (`branch <name>`) removed (or that would be). */
  removed: string[];
  skipped: { what: string; reason: string }[];
}

function defaultOps(repo: string): CleanOps {
  return {
    git: async (args, cwd) => {
      const res = await execa('git', ['-C', cwd ?? repo, ...args], { reject: false });
      return { exitCode: res.exitCode ?? 1, stdout: String(res.stdout ?? '') };
    },
    issueState: async (issue) =>
      String(
        (
          await execa('gh', ['issue', 'view', String(issue), '--json', 'state', '--jq', '.state'], {
            cwd: repo,
          })
        ).stdout,
      )
        .trim()
        .toUpperCase(),
    prs: async (branch) => {
      const stdout = String(
        (
          await execa(
            'gh',
            ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number,state'],
            { cwd: repo },
          )
        ).stdout,
      );
      const parsed: unknown = JSON.parse(stdout);
      if (!Array.isArray(parsed)) throw new Error('gh returned no list of pull requests');
      return parsed.map((p: { number: number; state: string }) => ({
        number: p.number,
        state: String(p.state).toUpperCase(),
      }));
    },
  };
}

const lines = (stdout: string): string[] =>
  stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');

const RUN_BRANCH = /^(?:feat|fix|chore|docs|ci)\/(\d+)-/;
const RUN_WORKTREE = new RegExp(`/${WORKTREE_DIR.replace('.', '\\.')}/(\\d+)$`);

interface Registered {
  path: string;
  branch: string | null;
}

function parseWorktrees(stdout: string): Registered[] {
  const out: Registered[] = [];
  for (const block of stdout.split(/\n\s*\n/)) {
    const ls = lines(block);
    const path = ls.find((l) => l.startsWith('worktree '))?.slice('worktree '.length);
    if (path === undefined) continue;
    const ref = ls.find((l) => l.startsWith('branch '))?.slice('branch '.length);
    out.push({ path, branch: ref?.replace(/^refs\/heads\//, '') ?? null });
  }
  return out;
}

export async function runClean(input: CleanInput): Promise<CleanResult> {
  const ops: CleanOps = { ...defaultOps(input.repo), ...input.ops };
  const dryRun = input.dryRun === true;
  const result: CleanResult = { pruned: [], removed: [], skipped: [] };

  const stale = await ops.git(['worktree', 'prune', '--dry-run', '--verbose']);
  result.pruned = lines(stale.stdout).map((l) => l.replace(/^Removing\s+/, ''));
  if (result.pruned.length > 0 && !dryRun) await ops.git(['worktree', 'prune']);

  const registered = parseWorktrees((await ops.git(['worktree', 'list', '--porcelain'])).stdout);
  const branches = lines(
    (await ops.git(['for-each-ref', '--format=%(refname:short)', 'refs/heads'])).stdout,
  );

  // Per issue: its run worktrees and run branches.
  const byIssue = new Map<number, { worktrees: Registered[]; branches: Set<string> }>();
  const entry = (nr: number) => {
    let e = byIssue.get(nr);
    if (!e) {
      e = { worktrees: [], branches: new Set() };
      byIssue.set(nr, e);
    }
    return e;
  };
  for (const w of registered) {
    const nr = RUN_WORKTREE.exec(w.path)?.[1];
    if (nr === undefined) continue;
    entry(Number(nr)).worktrees.push(w);
    if (w.branch !== null) entry(Number(nr)).branches.add(w.branch);
  }
  for (const b of branches) {
    const nr = RUN_BRANCH.exec(b)?.[1];
    if (nr !== undefined) entry(Number(nr)).branches.add(b);
  }

  for (const [nr, found] of [...byIssue].sort((a, b) => a[0] - b[0])) {
    if (input.issue !== undefined && nr !== input.issue) continue;
    const skip = (what: string, reason: string) => result.skipped.push({ what, reason });
    const label = `#${String(nr)}`;

    let issueClosed: boolean;
    let finished = false;
    let openPr: CleanPr | undefined;
    try {
      issueClosed = (await ops.issueState(nr)) === 'CLOSED';
      for (const branch of found.branches) {
        for (const pr of await ops.prs(branch)) {
          if (pr.state === 'OPEN') openPr = pr;
          else finished = true;
        }
      }
    } catch (error) {
      skip(label, `cannot read GitHub: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (openPr) {
      skip(label, `open pull request #${String(openPr.number)}`);
      continue;
    }
    if (!issueClosed && !finished) {
      skip(label, 'issue is open');
      continue;
    }

    const removedPaths = new Set<string>();
    for (const w of found.worktrees) {
      const rel = `${WORKTREE_DIR}/${basename(w.path)}`;
      const status = await ops.git(['status', '--porcelain'], w.path);
      if (status.exitCode !== 0 || lines(status.stdout).length > 0) {
        skip(rel, 'uncommitted changes');
        continue;
      }
      if (!dryRun) await ops.git(['worktree', 'remove', '--force', '--', w.path]);
      removedPaths.add(w.path);
      result.removed.push(rel);
    }
    for (const branch of found.branches) {
      const holder = registered.find((w) => w.branch === branch && !removedPaths.has(w.path));
      if (holder) {
        skip(`branch ${branch}`, `checked out in ${holder.path}`);
        continue;
      }
      if (!dryRun) await ops.git(['branch', '-D', '--', branch]);
      result.removed.push(`branch ${branch}`);
    }
  }
  return result;
}

/** Text lines of a clean result. */
export function describeClean(result: CleanResult, dryRun: boolean): string[] {
  const out: string[] = [];
  for (const p of result.pruned) out.push(`${dryRun ? 'would prune' : 'pruned'} ${p}`);
  for (const r of result.removed) out.push(`${dryRun ? 'would remove' : 'removed'} ${r}`);
  for (const s of result.skipped) out.push(`skipped ${s.what}: ${s.reason}`);
  if (out.length === 0) out.push('nothing to clean');
  return out;
}
