import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';
import { WORKTREE_DIR } from './git.js';

/**
 * Looks for what an earlier run of the same PBI left behind, before the claim and in `--dry-run`:
 * a worktree, a local or remote branch, an open pull request, stale worktree registrations. Branches
 * are found by the issue number (`*\/<nr>-*`), never rebuilt from the title: the title may have
 * changed since. Leftovers without work are removed; leftovers with work block the run.
 */

export interface PreflightPr {
  number: number;
  url: string;
}

/** Everything that touches git, `gh` or the file system; replaced in unit tests. */
export interface PreflightOps {
  /** Runs `git` in `cwd` (default: the repository); never rejects on a non-zero exit. */
  git: (args: string[], cwd?: string) => Promise<{ exitCode: number; stdout: string }>;
  /** Open pull requests whose head is `branch`. */
  openPrs: (branch: string) => Promise<PreflightPr[]>;
  exists: (path: string) => boolean;
}

export interface PreflightInput {
  repo: string;
  issue: number;
  /** The integration branch; commits are counted over `origin/<base>`. */
  base: string;
  /** Report only: nothing is pruned or removed. */
  dryRun?: boolean;
  /** Branch type segment; `*` matches every type. */
  namespace?: string;
  /** Directory name below the worktree directory; defaults to the issue number. */
  worktree?: string;
  /** Defaults to `.worktrees`. */
  worktreeDir?: string;
  ops?: Partial<PreflightOps>;
}

export interface PreflightResult {
  /** Stale worktree registrations that `git worktree prune` removes (or would remove). */
  pruned: string[];
  /** Leftovers without work that were removed (or would be, in a dry run). */
  removed: string[];
  /** Why the run cannot start; `null` when it can. */
  blocked: string | null;
}

export function describePreflight(result: PreflightResult, dryRun: boolean): string {
  if (result.blocked !== null) return `blocked, ${result.blocked}`;
  const parts: string[] = [];
  if (result.pruned.length > 0) {
    parts.push(`${dryRun ? 'would prune' : 'pruned'} ${result.pruned.join(', ')}`);
  }
  if (result.removed.length > 0) {
    parts.push(`${dryRun ? 'would remove' : 'removed'} ${result.removed.join(', ')}`);
  }
  return parts.length > 0 ? parts.join('; ') : 'nothing left from earlier runs';
}

function defaultOps(repo: string): PreflightOps {
  return {
    git: async (args, cwd) => {
      const res = await execa('git', ['-C', cwd ?? repo, ...args], { reject: false });
      return { exitCode: res.exitCode ?? 1, stdout: String(res.stdout ?? '') };
    },
    openPrs: async (branch) => {
      const stdout = String(
        (
          await execa(
            'gh',
            ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,url'],
            { cwd: repo },
          )
        ).stdout,
      );
      const parsed: unknown = JSON.parse(stdout);
      if (!Array.isArray(parsed))
        throw new Error(`gh returned no list of pull requests for ${branch}`);
      return parsed.map((p: { number: number; url: string }) => ({ number: p.number, url: p.url }));
    },
    exists: existsSync,
  };
}

const lines = (stdout: string): string[] =>
  stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');

export async function runPreflight(input: PreflightInput): Promise<PreflightResult> {
  const ops: PreflightOps = { ...defaultOps(input.repo), ...input.ops };
  const nr = String(input.issue);
  const namespace = input.namespace ?? '*';
  const dryRun = input.dryRun === true;
  const worktreeDir = input.worktreeDir ?? WORKTREE_DIR;
  const worktreeRel = `${worktreeDir}/${input.worktree ?? nr}`;
  const worktreePath = join(input.repo, worktreeDir, input.worktree ?? nr);
  const base = `origin/${input.base}`;

  const result: PreflightResult = { pruned: [], removed: [], blocked: null };

  const stale = await ops.git(['worktree', 'prune', '--dry-run', '--verbose']);
  result.pruned = lines(stale.stdout).map((l) => l.replace(/^Removing\s+/, ''));
  if (result.pruned.length > 0 && !dryRun) await ops.git(['worktree', 'prune']);

  const localList = await ops.git([
    'for-each-ref',
    '--format=%(refname:short)',
    `refs/heads/${namespace}/${nr}-*`,
  ]);
  const local = lines(localList.stdout);

  const remoteList = await ops.git(['ls-remote', '--heads', 'origin', `${namespace}/${nr}-*`]);
  if (remoteList.exitCode !== 0) throw new Error('cannot list the branches of origin');
  const remoteRef = new RegExp(
    `^refs/heads/(${namespace === '*' ? '[^/]+' : namespace}/${nr}-.*)$`,
  );
  const remote = lines(remoteList.stdout)
    .map((l) => remoteRef.exec(l.split(/\s+/)[1] ?? '')?.[1])
    .filter((b): b is string => b !== undefined);

  const prs: string[] = [];
  for (const branch of new Set([...local, ...remote])) {
    for (const pr of await ops.openPrs(branch)) {
      prs.push(`open pull request #${String(pr.number)} for ${branch}: ${pr.url}`);
    }
  }

  const work: string[] = [];
  const commitsOver = async (ref: string, cwd?: string): Promise<number | null> => {
    const res = await ops.git(['rev-list', '--count', `${base}..${ref}`], cwd);
    const count = Number(res.stdout.trim());
    return res.exitCode === 0 && Number.isInteger(count) ? count : null;
  };

  // `git worktree list` shows the worktrees that survived the prune.
  const listing = await ops.git(['worktree', 'list', '--porcelain']);
  const registered = lines(listing.stdout).some(
    (l) => l.startsWith('worktree ') && l.endsWith(`/${worktreeRel}`),
  );
  const worktreeExists = ops.exists(worktreePath);
  if (worktreeExists) {
    if (!registered) {
      work.push(`${worktreeRel} (not a registered worktree, content unknown)`);
    } else {
      const status = await ops.git(['status', '--porcelain'], worktreePath);
      const commits = await commitsOver('HEAD', worktreePath);
      if (status.exitCode !== 0 || lines(status.stdout).length > 0) {
        work.push(`${worktreeRel} (uncommitted changes)`);
      } else if (commits === null || commits > 0) {
        work.push(
          `${worktreeRel} (${commits === null ? 'commits unknown' : `${String(commits)} commit(s)`})`,
        );
      }
    }
  }

  const removableBranches: string[] = [];
  for (const branch of local) {
    const commits = await commitsOver(`refs/heads/${branch}`);
    if (commits === null || commits > 0) {
      work.push(
        `branch ${branch} (${commits === null ? 'commits unknown' : `${String(commits)} commit(s)`})`,
      );
    } else {
      removableBranches.push(branch);
    }
  }
  for (const branch of remote) work.push(`branch origin/${branch}`);

  if (prs.length > 0) {
    result.blocked = prs.join('; ');
    return result;
  }
  if (work.length > 0) {
    result.blocked = `leftovers of an earlier run of #${nr}: ${work.join(', ')}; continue them with \`dromos run pbi ${nr} --resume\` or discard them with \`dromos run pbi ${nr} --restart\``;
    return result;
  }

  if (worktreeExists && registered) {
    if (!dryRun) await ops.git(['worktree', 'remove', '--force', '--', worktreePath]);
    result.removed.push(worktreeRel);
  }
  for (const branch of removableBranches) {
    if (!dryRun) await ops.git(['branch', '-D', '--', branch]);
    result.removed.push(`branch ${branch}`);
  }
  return result;
}
