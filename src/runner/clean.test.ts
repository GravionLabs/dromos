import { describe, expect, it } from 'vitest';
import { type CleanOps, describeClean, runClean } from './clean.js';

const R = '/r';
const wt = (nr: number, branch: string) =>
  `worktree ${R}/.worktrees/${String(nr)}\nHEAD abc\nbranch refs/heads/${branch}\n`;

interface World {
  worktrees: string[];
  branches: string[];
  dirty?: string[];
  issues: Record<number, string>;
  prs?: Record<string, { number: number; state: string }[]>;
  stale?: string;
}

function fake(w: World) {
  const git: string[] = [];
  const ops: CleanOps = {
    git: async (args, cwd) => {
      const cmd = args.join(' ');
      if (cmd === 'worktree prune --dry-run --verbose')
        return { exitCode: 0, stdout: w.stale ?? '' };
      if (cmd === 'worktree list --porcelain') {
        return {
          exitCode: 0,
          stdout: `worktree ${R}\nHEAD abc\nbranch refs/heads/main\n\n${w.worktrees.join('\n')}`,
        };
      }
      if (cmd.startsWith('for-each-ref')) return { exitCode: 0, stdout: w.branches.join('\n') };
      if (cmd === 'status --porcelain') {
        return { exitCode: 0, stdout: w.dirty?.some((d) => cwd?.endsWith(d)) ? ' M f.ts' : '' };
      }
      git.push(cmd);
      return { exitCode: 0, stdout: '' };
    },
    issueState: async (nr) => w.issues[nr] ?? 'OPEN',
    prs: async (branch) => w.prs?.[branch] ?? [],
  };
  return { ops, git };
}

describe('runClean', () => {
  const closed: World = {
    worktrees: [wt(5, 'feat/5-x')],
    branches: ['main', 'feat/5-x'],
    issues: { 5: 'CLOSED' },
  };

  it('removes worktree and branch of a closed issue', async () => {
    const f = fake(closed);
    const res = await runClean({ repo: R, ops: f.ops });
    expect(res.removed).toEqual(['.worktrees/5', 'branch feat/5-x']);
    expect(res.skipped).toEqual([]);
    expect(f.git).toEqual([
      `worktree remove --force -- ${R}/.worktrees/5`,
      'branch -D -- feat/5-x',
    ]);
  });

  it('removes what belongs to a merged pull request while the issue is still open', async () => {
    const f = fake({
      ...closed,
      issues: { 5: 'OPEN' },
      prs: { 'feat/5-x': [{ number: 9, state: 'MERGED' }] },
    });
    const res = await runClean({ repo: R, ops: f.ops });
    expect(res.removed).toEqual(['.worktrees/5', 'branch feat/5-x']);
  });

  it('removes a branch left without a worktree', async () => {
    const f = fake({ worktrees: [], branches: ['main', 'fix/7-y'], issues: { 7: 'CLOSED' } });
    const res = await runClean({ repo: R, ops: f.ops });
    expect(res.removed).toEqual(['branch fix/7-y']);
    expect(f.git).toEqual(['branch -D -- fix/7-y']);
  });

  it('skips an issue that is still open', async () => {
    const f = fake({ ...closed, issues: { 5: 'OPEN' } });
    const res = await runClean({ repo: R, ops: f.ops });
    expect(res.removed).toEqual([]);
    expect(res.skipped).toEqual([{ what: '#5', reason: 'issue is open' }]);
    expect(f.git).toEqual([]);
  });

  it('skips an issue with an open pull request even when the issue is closed', async () => {
    const f = fake({ ...closed, prs: { 'feat/5-x': [{ number: 9, state: 'OPEN' }] } });
    const res = await runClean({ repo: R, ops: f.ops });
    expect(res.removed).toEqual([]);
    expect(res.skipped).toEqual([{ what: '#5', reason: 'open pull request #9' }]);
  });

  it('never removes a worktree with uncommitted changes and lists it', async () => {
    const f = fake({ ...closed, dirty: ['/5'] });
    const res = await runClean({ repo: R, ops: f.ops });
    expect(res.removed).toEqual([]);
    expect(res.skipped).toContainEqual({ what: '.worktrees/5', reason: 'uncommitted changes' });
    expect(f.git.some((c) => c.includes('worktree remove'))).toBe(false);
    expect(f.git.some((c) => c.includes('branch -D'))).toBe(false);
  });

  it('changes nothing in a dry run but reports what it would do', async () => {
    const f = fake({
      ...closed,
      stale: 'Removing .worktrees/old: gitdir file points to non-existent location',
    });
    const res = await runClean({ repo: R, dryRun: true, ops: f.ops });
    expect(res.removed).toEqual(['.worktrees/5', 'branch feat/5-x']);
    expect(res.pruned).toHaveLength(1);
    expect(f.git).toEqual([]);
    expect(describeClean(res, true)).toEqual([
      'would prune .worktrees/old: gitdir file points to non-existent location',
      'would remove .worktrees/5',
      'would remove branch feat/5-x',
    ]);
  });

  it('prunes stale registrations', async () => {
    const f = fake({
      worktrees: [],
      branches: [],
      issues: {},
      stale: 'Removing .worktrees/9: gone',
    });
    const res = await runClean({ repo: R, ops: f.ops });
    expect(res.pruned).toEqual(['.worktrees/9: gone']);
    expect(f.git).toEqual(['worktree prune']);
  });

  it('limits itself to the given issue', async () => {
    const f = fake({
      worktrees: [wt(5, 'feat/5-x'), wt(6, 'feat/6-y')],
      branches: ['feat/5-x', 'feat/6-y'],
      issues: { 5: 'CLOSED', 6: 'CLOSED' },
    });
    const res = await runClean({ repo: R, issue: 6, ops: f.ops });
    expect(res.removed).toEqual(['.worktrees/6', 'branch feat/6-y']);
  });

  it('skips a branch checked out in another worktree', async () => {
    const f = fake({
      worktrees: [`worktree /elsewhere\nHEAD abc\nbranch refs/heads/feat/5-x\n`],
      branches: ['feat/5-x'],
      issues: { 5: 'CLOSED' },
    });
    const res = await runClean({ repo: R, ops: f.ops });
    expect(res.removed).toEqual([]);
    expect(res.skipped).toEqual([{ what: 'branch feat/5-x', reason: 'checked out in /elsewhere' }]);
  });

  it('skips an issue it cannot read from GitHub', async () => {
    const f = fake(closed);
    f.ops.issueState = async () => {
      throw new Error('gh: offline');
    };
    const res = await runClean({ repo: R, ops: f.ops });
    expect(res.skipped).toEqual([{ what: '#5', reason: 'cannot read GitHub: gh: offline' }]);
  });

  it('says so when there is nothing to clean', () => {
    expect(describeClean({ pruned: [], removed: [], skipped: [] }, false)).toEqual([
      'nothing to clean',
    ]);
  });
});
