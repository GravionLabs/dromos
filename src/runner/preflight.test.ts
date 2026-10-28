import { beforeEach, describe, expect, it } from 'vitest';
import { type PreflightOps, type PreflightPr, runPreflight } from './preflight.js';

interface World {
  /** Output of `git worktree prune --dry-run --verbose`. */
  stale: string[];
  local: Record<string, number>;
  remote: string[];
  prs: Record<string, PreflightPr[]>;
  /** The `.worktrees/322` directory: commits over the base and whether it is dirty; `null` = absent. */
  worktree: { commits: number; dirty: boolean; registered: boolean } | null;
  offline: boolean;
}

const REPO = '/r';
let world: World;
let log: string[];

beforeEach(() => {
  world = { stale: [], local: {}, remote: [], prs: {}, worktree: null, offline: false };
  log = [];
});

const git: PreflightOps['git'] = async (args, cwd) => {
  const cmd = args.join(' ');
  log.push(cwd === undefined ? cmd : `${cmd} @${cwd}`);
  const ok = (stdout = '') => ({ exitCode: 0, stdout });
  if (cmd === 'worktree prune --dry-run --verbose') return ok(world.stale.join('\n'));
  if (cmd.startsWith('for-each-ref')) return ok(Object.keys(world.local).join('\n'));
  if (cmd.startsWith('ls-remote')) {
    if (world.offline) return { exitCode: 128, stdout: '' };
    return ok(world.remote.map((b) => `abc\trefs/heads/${b}`).join('\n'));
  }
  if (cmd === 'worktree list --porcelain') {
    return ok(
      world.worktree?.registered ? `worktree ${REPO}/.worktrees/322\nHEAD abc\nbranch x` : '',
    );
  }
  if (cmd === 'status --porcelain') return ok(world.worktree?.dirty ? ' M a.ts' : '');
  if (cmd === 'rev-list --count origin/release/next..HEAD') {
    return ok(String(world.worktree?.commits ?? 0));
  }
  const rev = /^rev-list --count origin\/release\/next\.\.refs\/heads\/(.+)$/.exec(cmd);
  if (rev) return ok(String(world.local[rev[1] as string] ?? 0));
  return ok();
};

const run = (dryRun = false) =>
  runPreflight({
    repo: REPO,
    issue: 322,
    base: 'release/next',
    dryRun,
    ops: {
      git,
      openPrs: async (branch) => world.prs[branch] ?? [],
      exists: (p) => p === `${REPO}/.worktrees/322` && world.worktree !== null,
    },
  });

const mutations = () =>
  log.filter((c) => /^(worktree (prune$|remove)|branch -D)/.test(c.replace(/ @.*/, '')));

describe('runPreflight', () => {
  it('finds nothing and changes nothing', async () => {
    expect(await run()).toEqual({ pruned: [], removed: [], blocked: null });
    expect(mutations()).toEqual([]);
  });

  it('removes an empty leftover (worktree and branch) and names what it removed', async () => {
    world.worktree = { commits: 0, dirty: false, registered: true };
    world.local = { 'fix/322-old-title': 0 };
    const res = await run();
    expect(res).toEqual({
      pruned: [],
      removed: ['.worktrees/322', 'branch fix/322-old-title'],
      blocked: null,
    });
    expect(mutations()).toEqual([
      `worktree remove --force -- ${REPO}/.worktrees/322`,
      'branch -D -- fix/322-old-title',
    ]);
  });

  it('blocks on a leftover with commits and names --resume and --restart', async () => {
    world.local = { 'fix/322-x': 2 };
    const res = await run();
    expect(res.blocked).toContain('branch fix/322-x (2 commit(s))');
    expect(res.blocked).toContain('dromos run pbi 322 --resume');
    expect(res.blocked).toContain('dromos run pbi 322 --restart');
    expect(mutations()).toEqual([]);
  });

  it('blocks on a worktree with uncommitted changes and keeps the empty branch', async () => {
    world.worktree = { commits: 0, dirty: true, registered: true };
    world.local = { 'fix/322-x': 0 };
    const res = await run();
    expect(res.blocked).toContain('.worktrees/322 (uncommitted changes)');
    expect(mutations()).toEqual([]);
  });

  it('blocks on commits in the worktree', async () => {
    world.worktree = { commits: 1, dirty: false, registered: true };
    expect((await run()).blocked).toContain('.worktrees/322 (1 commit(s))');
  });

  it('blocks on a directory that is not a registered worktree', async () => {
    world.worktree = { commits: 0, dirty: false, registered: false };
    const res = await run();
    expect(res.blocked).toContain('not a registered worktree');
    expect(mutations()).toEqual([]);
  });

  it('blocks on a branch that exists only on origin', async () => {
    world.remote = ['feat/322-renamed'];
    const res = await run();
    expect(res.blocked).toContain('branch origin/feat/322-renamed');
    expect(mutations()).toEqual([]);
  });

  it('ignores remote branches of other issues', async () => {
    world.remote = ['feat/3220-other', 'feat/32-other'];
    expect((await run()).blocked).toBeNull();
  });

  it('blocks on an open pull request and names its URL', async () => {
    world.local = { 'fix/322-x': 0 };
    world.remote = ['fix/322-x'];
    world.prs = { 'fix/322-x': [{ number: 9, url: 'https://github.com/o/r/pull/9' }] };
    const res = await run();
    expect(res.blocked).toContain('https://github.com/o/r/pull/9');
    expect(res.blocked).toContain('#9');
    expect(mutations()).toEqual([]);
  });

  it('prunes stale registrations', async () => {
    world.stale = ['Removing .worktrees/322: gitdir file points to non-existent location'];
    const res = await run();
    expect(res.pruned).toEqual(['.worktrees/322: gitdir file points to non-existent location']);
    expect(mutations()).toEqual(['worktree prune']);
  });

  it('finds the branch of a renamed issue by its number', async () => {
    world.local = { 'chore/322-a-completely-different-title': 3 };
    expect((await run()).blocked).toContain('chore/322-a-completely-different-title');
    expect(log.find((c) => c.startsWith('for-each-ref'))).toContain('refs/heads/*/322-*');
    expect(log.find((c) => c.startsWith('ls-remote'))).toContain('*/322-*');
  });

  it('a dry run reports but changes nothing', async () => {
    world.stale = ['Removing .worktrees/x: gone'];
    world.worktree = { commits: 0, dirty: false, registered: true };
    world.local = { 'fix/322-x': 0 };
    const res = await run(true);
    expect(res.pruned).toHaveLength(1);
    expect(res.removed).toEqual(['.worktrees/322', 'branch fix/322-x']);
    expect(mutations()).toEqual([]);
  });

  it('throws when origin cannot be listed instead of assuming nothing is left', async () => {
    world.offline = true;
    await expect(run()).rejects.toThrow(/origin/);
  });

  it('limits the search to a branch type and worktree name (spike)', async () => {
    const res = await runPreflight({
      repo: REPO,
      issue: 322,
      base: 'release/next',
      namespace: 'spike',
      worktree: 'spike-322',
      ops: { git, openPrs: async () => [], exists: () => false },
    });
    expect(res.blocked).toBeNull();
    expect(log.find((c) => c.startsWith('for-each-ref'))).toContain('refs/heads/spike/322-*');
  });
});
