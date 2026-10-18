import { execa } from 'execa';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { repoFromPath, viewIssue } from './github.js';

vi.mock('execa');
const mockExeca = vi.mocked(execa) as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockExeca.mockReset();
});

describe('viewIssue', () => {
  it('calls gh with exact args and maps labels to names', async () => {
    mockExeca.mockResolvedValue({
      stdout: JSON.stringify({
        number: 14,
        title: 'T',
        body: 'B',
        labels: [{ name: 'pbi' }, { name: 'bug' }],
      }),
    });
    const issue = await viewIssue('o/r', 14);
    expect(mockExeca).toHaveBeenCalledWith('gh', [
      'issue',
      'view',
      '14',
      '-R',
      'o/r',
      '--json',
      'number,title,body,labels',
    ]);
    expect(issue).toEqual({ number: 14, title: 'T', body: 'B', labels: ['pbi', 'bug'] });
  });

  it('defaults a null body to empty string and missing labels to []', async () => {
    mockExeca.mockResolvedValue({ stdout: '{"number":1,"title":"x","body":null}' });
    expect(await viewIssue('o/r', 1)).toEqual({ number: 1, title: 'x', body: '', labels: [] });
  });

  it('throws a clear error on malformed JSON', async () => {
    mockExeca.mockResolvedValue({ stdout: 'not json' });
    await expect(viewIssue('o/r', 3)).rejects.toThrow('malformed JSON for issue #3 in o/r');
  });

  it('propagates gh failures', async () => {
    mockExeca.mockRejectedValue(new Error('gh failed'));
    await expect(viewIssue('o/r', 1)).rejects.toThrow('gh failed');
  });
});

describe('repoFromPath', () => {
  it('runs gh repo view in the repo path and trims output', async () => {
    mockExeca.mockResolvedValue({ stdout: 'owner/name\n' });
    expect(await repoFromPath('/work/repo')).toBe('owner/name');
    expect(mockExeca).toHaveBeenCalledWith(
      'gh',
      ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
      { cwd: '/work/repo' },
    );
  });

  it('propagates gh failures', async () => {
    mockExeca.mockRejectedValue(new Error('not a repo'));
    await expect(repoFromPath('/x')).rejects.toThrow('not a repo');
  });
});
