import { execa } from 'execa';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  finishRunWorktree,
  integrationBranch,
  MissingIntegrationBranchError,
  openRunWorktree,
  runBranchName,
} from './git.js';

vi.mock('execa');
vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  realpathSync: vi.fn((p: string) => p),
}));
const mockExeca = vi.mocked(execa) as unknown as ReturnType<typeof vi.fn>;

const ok = { exitCode: 0, stdout: '' };
const calls = () => mockExeca.mock.calls.map((c) => (c[1] as string[]).join(' '));

beforeEach(() => {
  mockExeca.mockReset();
});

describe('integrationBranch', () => {
  it('prefers release/next when the remote has it', async () => {
    mockExeca.mockResolvedValue(ok);
    expect(await integrationBranch('/r')).toBe('release/next');
  });

  it('blocks instead of falling back to the default branch', async () => {
    mockExeca.mockResolvedValue({ exitCode: 2, stdout: '' });
    const err = await integrationBranch('/r').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MissingIntegrationBranchError);
    expect((err as Error).message).toContain('github-release cut');
    expect(calls().some((c) => c.includes('symbolic-ref'))).toBe(false);
  });

  it('uses the configured base when release/next is missing', async () => {
    mockExeca.mockResolvedValue({ exitCode: 2, stdout: '' });
    expect(await integrationBranch('/r', 'main')).toBe('main');
  });

  it('prefers release/next over the configured base', async () => {
    mockExeca.mockResolvedValue(ok);
    expect(await integrationBranch('/r', 'main')).toBe('release/next');
  });
});

describe('runBranchName', () => {
  it('builds <type>/<nr>-<slug>', () => {
    expect(runBranchName('feat', 221, 'Worktree, branch & claim')).toBe(
      'feat/221-worktree-branch-claim',
    );
  });

  it('uses a placeholder for an empty slug', () => {
    expect(runBranchName('chore', 5, '***')).toBe('chore/5-task');
  });
});

describe('openRunWorktree', () => {
  it('cuts <repo>/.worktrees/<nr> from the integration branch', async () => {
    mockExeca.mockImplementation(async (_c: string, args: string[]) =>
      args.includes('rev-parse') ? { exitCode: 1, stdout: '' } : ok,
    );
    const wt = await openRunWorktree('/r', 221, 'feat', 'Add thing');
    expect(wt).toEqual({
      path: '/r/.worktrees/221',
      branch: 'feat/221-add-thing',
      base: 'release/next',
    });
    expect(calls()).toContain(
      '-C /r worktree add -b feat/221-add-thing -- /r/.worktrees/221 origin/release/next',
    );
  });

  it('refuses when .worktrees is not git-ignored', async () => {
    mockExeca.mockImplementation(async (_c: string, args: string[]) =>
      args.includes('check-ignore') ? { exitCode: 1, stdout: '' } : ok,
    );
    await expect(openRunWorktree('/r', 1, 'fix', 'x')).rejects.toThrow('not git-ignored');
  });
});

describe('finishRunWorktree', () => {
  const wt = { path: '/r/.worktrees/221', branch: 'b', base: 'release/next' };

  it('removes the worktree and the local branch on pr_opened', async () => {
    mockExeca.mockResolvedValue(ok);
    expect(await finishRunWorktree('/r', wt, 'pr_opened')).toBe(true);
    expect(calls()).toEqual([
      '-C /r worktree remove --force -- /r/.worktrees/221',
      '-C /r branch -D -- b',
    ]);
  });

  it('removes worktree and branch after a failure when no commit exists over the base', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: '0' });
    expect(await finishRunWorktree('/r', wt, 'failed')).toBe(true);
    expect(calls()).toEqual([
      '-C /r/.worktrees/221 rev-list --count origin/release/next..HEAD',
      '-C /r worktree remove --force -- /r/.worktrees/221',
      '-C /r branch -D -- b',
    ]);
  });

  it('keeps worktree and branch after a failure when commits exist', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: '2' });
    expect(await finishRunWorktree('/r', wt, 'failed')).toBe(false);
    expect(calls()).toEqual(['-C /r/.worktrees/221 rev-list --count origin/release/next..HEAD']);
  });

  it('keeps them after a failure when the commits cannot be counted', async () => {
    mockExeca.mockResolvedValue({ exitCode: 128, stdout: '' });
    expect(await finishRunWorktree('/r', wt, 'failed')).toBe(false);
    expect(calls()).toHaveLength(1);
  });

  it('keeps the worktree on blocked', async () => {
    expect(await finishRunWorktree('/r', wt, 'blocked')).toBe(false);
    expect(mockExeca).not.toHaveBeenCalled();
  });
});
