import { execa } from 'execa';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { finishRunWorktree, integrationBranch, openRunWorktree, runBranchName } from './git.js';

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

  it('falls back to the remote default branch', async () => {
    mockExeca
      .mockResolvedValueOnce({ exitCode: 2, stdout: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'origin/develop\n' });
    expect(await integrationBranch('/r')).toBe('develop');
  });

  it('falls back to main when nothing is known', async () => {
    mockExeca.mockResolvedValue({ exitCode: 1, stdout: '' });
    expect(await integrationBranch('/r')).toBe('main');
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

  it('removes the worktree on pr_opened', async () => {
    mockExeca.mockResolvedValue(ok);
    expect(await finishRunWorktree('/r', wt, 'pr_opened')).toBe(true);
    expect(calls()).toEqual(['-C /r worktree remove --force -- /r/.worktrees/221']);
  });

  it('keeps the worktree on blocked', async () => {
    expect(await finishRunWorktree('/r', wt, 'blocked')).toBe(false);
    expect(mockExeca).not.toHaveBeenCalled();
  });
});
