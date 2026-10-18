import { existsSync } from 'node:fs';
import { execa } from 'execa';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorktree, slugify } from './worktree.js';

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
    expect(slugify('x'.repeat(60))).toHaveLength(40);
  });
});

describe('createWorktree', () => {
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
      ['git', ['-C', '/repo', 'fetch', 'origin', 'main']],
      ['git', ['-C', '/repo', 'worktree', 'add', '-b', 'agent/14-x', '/wt/x', 'origin/main']],
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
