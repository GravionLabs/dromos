import { execa } from 'execa';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLAIM_LABEL,
  ClaimError,
  claimIssue,
  createPr,
  markReady,
  readIssue,
  releaseIssue,
  updatePr,
} from './github.js';

vi.mock('execa');
const mockExeca = vi.mocked(execa) as unknown as ReturnType<typeof vi.fn>;

const issueJson = (labels: string[] = []) =>
  JSON.stringify({ number: 7, title: 'T', body: 'B', labels: labels.map((name) => ({ name })) });

/** Answers `gh` by its first words; records nothing else. */
function answer(routes: Record<string, string>): void {
  mockExeca.mockImplementation(async (_cmd: string, args: string[]) => {
    const key = Object.keys(routes).find((k) => args.join(' ').includes(k));
    if (!key) throw new Error(`unexpected gh ${args.join(' ')}`);
    return { stdout: routes[key] };
  });
}

const ghCalls = () => mockExeca.mock.calls.map((c) => (c[1] as string[]).join(' '));

beforeEach(() => {
  mockExeca.mockReset();
});

describe('readIssue', () => {
  it('adds sub-issues and blocked-by to the issue', async () => {
    answer({
      'issue view': issueJson(['pbi']),
      '/sub_issues': '[{"number":8,"title":"Task","state":"open"}]',
      '/dependencies/blocked_by': '[{"number":3,"title":"B","state":"closed"}]',
    });
    const issue = await readIssue('o/r', 7);
    expect(issue.labels).toEqual(['pbi']);
    expect(issue.subIssues).toEqual([{ number: 8, title: 'Task', state: 'open' }]);
    expect(issue.blockedBy).toEqual([{ number: 3, title: 'B', state: 'closed' }]);
    expect(ghCalls()).toContain('api repos/o/r/issues/7/sub_issues');
  });

  it('rejects malformed JSON', async () => {
    answer({ 'issue view': issueJson(), '/sub_issues': 'nope', '/dependencies': '[]' });
    await expect(readIssue('o/r', 7)).rejects.toThrow('malformed JSON');
  });
});

describe('claimIssue', () => {
  it('labels the issue and comments the run id', async () => {
    answer({ 'issue view': issueJson(), 'issue edit': '', 'issue comment': '' });
    await claimIssue('o/r', 7, 'run-1');
    expect(ghCalls()).toContain(`issue edit 7 -R o/r --add-label ${CLAIM_LABEL}`);
    expect(ghCalls().some((c) => c.startsWith('issue comment 7') && c.includes('run-1'))).toBe(
      true,
    );
  });

  it('refuses a labelled PBI without force and changes nothing', async () => {
    answer({ 'issue view': issueJson([CLAIM_LABEL]) });
    await expect(claimIssue('o/r', 7, 'run-1')).rejects.toBeInstanceOf(ClaimError);
    expect(ghCalls().every((c) => c.startsWith('issue view'))).toBe(true);
  });

  it('takes a labelled PBI over with force', async () => {
    answer({ 'issue view': issueJson([CLAIM_LABEL]), 'issue edit': '', 'issue comment': '' });
    await claimIssue('o/r', 7, 'run-2', true);
    expect(ghCalls()).toContain(`issue edit 7 -R o/r --add-label ${CLAIM_LABEL}`);
  });
});

describe('releaseIssue', () => {
  it('removes the label', async () => {
    answer({ 'issue edit': '' });
    await releaseIssue('o/r', 7);
    expect(ghCalls()).toEqual([`issue edit 7 -R o/r --remove-label ${CLAIM_LABEL}`]);
  });
});

describe('pull requests', () => {
  it('creates a PR and parses its number', async () => {
    answer({ 'pr create': 'https://github.com/o/r/pull/42\n' });
    const pr = await createPr('o/r', {
      base: 'release/next',
      head: 'feat/7-x',
      title: 'T',
      body: 'B',
    });
    expect(pr).toEqual({ number: 42, url: 'https://github.com/o/r/pull/42' });
    expect(ghCalls()[0]).not.toContain('--draft');
  });

  it('creates a draft PR', async () => {
    answer({ 'pr create': 'https://github.com/o/r/pull/43' });
    await createPr('o/r', { base: 'main', head: 'h', title: 'T', body: 'B', draft: true });
    expect(ghCalls()[0]).toContain('--draft');
  });

  it('fails when gh prints no PR url', async () => {
    answer({ 'pr create': 'something else' });
    await expect(
      createPr('o/r', { base: 'main', head: 'h', title: 'T', body: 'B' }),
    ).rejects.toThrow('no https PR url');
  });

  it('updates through the REST endpoint, not gh pr edit', async () => {
    answer({ 'api -X PATCH': '{}' });
    await updatePr('o/r', 42, { title: 'N', body: 'M' });
    expect(ghCalls()).toEqual(['api -X PATCH repos/o/r/pulls/42 -f title=N -f body=M']);
  });

  it('marks a draft ready', async () => {
    answer({ 'pr ready': '' });
    await markReady('o/r', 42);
    expect(ghCalls()).toEqual(['pr ready 42 -R o/r']);
  });
});
