import { execa } from 'execa';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { APPROVAL_LABEL, createIssues } from './create-issues.js';
import type { Plan } from './plan.js';

vi.mock('execa');
const mockExeca = vi.mocked(execa) as unknown as ReturnType<typeof vi.fn>;

const feature = { level: 'Feature', number: 210, title: 'F', body: '' } as const;
const ghCalls = () => mockExeca.mock.calls.map((c) => (c[1] as string[]).join(' '));
const creates = () =>
  mockExeca.mock.calls.map((c) => c[1] as string[]).filter((a) => a[0] === 'issue');

/** Fake `gh`: new issues are numbered from 101; the REST id of issue N is N * 10. */
function fakeGh(): void {
  let next = 101;
  mockExeca.mockImplementation(async (_cmd: string, args: string[]) => {
    if (args[0] === 'issue' && args[1] === 'create') {
      const n = next++;
      return { stdout: `https://github.com/o/r/issues/${String(n)}\n` };
    }
    const m = /^repos\/o\/r\/issues\/(\d+)$/.exec(args[1] ?? '');
    if (args[0] === 'api' && m) return { stdout: `${String(Number(m[1]) * 10)}\n` };
    return { stdout: '' };
  });
}

const plan: Plan = {
  items: [
    { id: 'a', title: 'First', body: 'do a', dependsOn: [] },
    { id: 'b', title: 'Second', body: 'do b', dependsOn: ['a'] },
  ],
  questions: [],
  assumptions: [],
};

beforeEach(() => {
  mockExeca.mockReset();
  fakeGh();
});

describe('createIssues', () => {
  it('creates PBIs under a Feature with prefix, parent line and label', async () => {
    const created = await createIssues('o/r', feature, plan);
    expect(created).toEqual([
      { id: 'a', number: 101 },
      { id: 'b', number: 102 },
    ]);
    expect(creates()[0]).toEqual([
      'issue',
      'create',
      '-R',
      'o/r',
      '--title',
      '[PBI] First',
      '--body',
      'Parent Feature: #210\n\ndo a',
      '--label',
      APPROVAL_LABEL,
    ]);
    expect(creates()[1]?.[5]).toBe('[PBI] Second');
  });

  it('creates Tasks under a PBI', async () => {
    await createIssues('o/r', { level: 'PBI', number: 226, title: 'P', body: '' }, plan);
    expect(creates()[0]?.[5]).toBe('[Task] First');
    expect(creates()[0]?.[7]).toBe('Parent PBI: #226\n\ndo a');
  });

  it('links each issue as native sub-issue and blocked-by from dependsOn', async () => {
    await createIssues('o/r', feature, plan);
    const calls = ghCalls();
    expect(calls).toContain('api -X POST repos/o/r/issues/210/sub_issues -F sub_issue_id=1010');
    expect(calls).toContain('api -X POST repos/o/r/issues/210/sub_issues -F sub_issue_id=1020');
    expect(calls.filter((c) => c.includes('/dependencies/blocked_by'))).toEqual([
      'api -X POST repos/o/r/issues/102/dependencies/blocked_by -F issue_id=1010',
    ]);
  });

  it('creates nothing for an invalid plan', async () => {
    const bad: Plan = { ...plan, items: [{ id: 'a', title: 'A', body: '', dependsOn: ['x'] }] };
    await expect(createIssues('o/r', feature, bad)).rejects.toThrow(/unknown item/);
    expect(mockExeca).not.toHaveBeenCalled();
  });

  it('fails when gh prints no issue url', async () => {
    mockExeca.mockImplementation(async () => ({ stdout: 'oops' }));
    await expect(createIssues('o/r', feature, plan)).rejects.toThrow(/no issue url/);
  });
});
