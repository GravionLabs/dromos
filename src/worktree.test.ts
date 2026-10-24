import { existsSync } from 'node:fs';
import { execa } from 'execa';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assertWorktreeDirIgnored, createWorktree, isSafeBranchName, slugify } from './worktree.js';

vi.mock('execa');
vi.mock('node:fs', () => ({ existsSync: vi.fn() }));
const mockExeca = vi.mocked(execa) as unknown as ReturnType<typeof vi.fn>;
const mockExists = vi.mocked(existsSync);

beforeEach(() => {
  mockExeca.mockReset();
  mockExists.mockReset();
});

describe('slugify', () => {
  it.each([
    ['Add Start Run Tool', 'add-start-run-tool'],
    ['  Hello,   World!!  ', 'hello-world'],
    ['feat: `start_run` (v2)', 'feat-start-run-v2'],
    ['', ''],
    ['***', ''],
  ])('%j -> %j', (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  it('truncates to 40 chars without a trailing dash', () => {
    const slug = slugify(`${'a'.repeat(39)} bbbbbb`);
    expect(slug).toBe('a'.repeat(39));
    expect(slugify('x'.repeat(60))).toBe('x'.repeat(40));
    expect(slugify(`${'a'.repeat(38)} bbbb`)).toBe(`${'a'.repeat(38)}-b`);
  });
});

describe('isSafeBranchName', () => {
  it.each(['main', 'release/1.2', 'feature_x', 'agent/14-x'])('accepts %j', (n) => {
    expect(isSafeBranchName(n)).toBe(true);
  });
  it.each(['topic.lock', 'dir/', '-x', '--upload-pack=x', 'a..b', 'a b', 'a\nb', 'a\tb', ''])(
    'rejects %j',
    (n) => {
      expect(isSafeBranchName(n)).toBe(false);
    },
  );
});

describe('createWorktree', () => {
  it.each(['--upload-pack=touch /tmp/x', '-x', 'a..b', 'a b', 'main\nx', ''])(
    'rejects unsafe base branch %j without running git',
    async (base) => {
      mockExists.mockReturnValue(false);
      await expect(createWorktree('/repo', base, 'b', '/wt/x')).rejects.toThrow(
        'invalid base branch name',
      );
      expect(mockExeca).not.toHaveBeenCalled();
    },
  );

  it('fetches then adds the worktree with exact args', async () => {
    mockExists.mockReturnValue(false);
    mockExeca.mockResolvedValueOnce({ exitCode: 1 }).mockResolvedValue({ exitCode: 0 });
    await createWorktree('/repo', 'main', 'agent/14-x', '/wt/x');
    expect(mockExeca.mock.calls).toEqual([
      [
        'git',
        ['-C', '/repo', 'rev-parse', '--verify', '--quiet', 'refs/heads/agent/14-x'],
        { reject: false },
      ],
      ['git', ['-C', '/repo', 'fetch', '--', 'origin', 'main']],
      ['git', ['-C', '/repo', 'worktree', 'add', '-b', 'agent/14-x', '--', '/wt/x', 'origin/main']],
    ]);
  });

  it('throws when the worktree path exists and runs no git command', async () => {
    mockExists.mockReturnValue(true);
    await expect(createWorktree('/repo', 'main', 'b', '/wt/x')).rejects.toThrow(
      'worktree path already exists: /wt/x',
    );
    expect(mockExeca).not.toHaveBeenCalled();
  });

  it('throws when the branch exists and does not fetch or add', async () => {
    mockExists.mockReturnValue(false);
    mockExeca.mockResolvedValue({ exitCode: 0 });
    await expect(createWorktree('/repo', 'main', 'b', '/wt/x')).rejects.toThrow(
      'branch already exists: b',
    );
    expect(mockExeca).toHaveBeenCalledTimes(1);
  });

  it('propagates git failures', async () => {
    mockExists.mockReturnValue(false);
    mockExeca
      .mockResolvedValueOnce({ exitCode: 1 })
      .mockRejectedValueOnce(new Error('fetch failed'));
    await expect(createWorktree('/repo', 'main', 'b', '/wt/x')).rejects.toThrow('fetch failed');
  });
});

describe('assertWorktreeDirIgnored', () => {
  it.each(['.worktrees', 'work/trees'])('checks %s with exact args', async (dir) => {
    mockExeca.mockResolvedValue({ exitCode: 0 });
    await assertWorktreeDirIgnored('/repo', dir);
    expect(mockExeca.mock.calls).toEqual([
      ['git', ['-C', '/repo', 'check-ignore', '-q', '--', `${dir}/probe`], { reject: false }],
    ]);
  });

  it('throws the readable error when the dir is not ignored (exit 1)', async () => {
    mockExeca.mockResolvedValue({ exitCode: 1 });
    await expect(assertWorktreeDirIgnored('/repo', '.worktrees')).rejects.toThrow(
      "worktree directory '.worktrees' is not git-ignored in /repo; add '.worktrees/' to .gitignore (apm-hub: Enable-Worktrees.ps1)",
    );
  });

  it('throws a generic error on other exit codes', async () => {
    mockExeca.mockResolvedValue({ exitCode: 128 });
    await expect(assertWorktreeDirIgnored('/repo', '.worktrees')).rejects.toThrow(
      'git check-ignore failed in /repo (exit code 128)',
    );
  });
});
