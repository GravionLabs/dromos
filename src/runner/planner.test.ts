import { execa } from 'execa';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Harness } from './harness.js';
import {
  createPlanIssues,
  type Plan,
  readPlanSchemaFile,
  runPlannerPhase,
  serializePlanSchema,
  validatePlan,
} from './planner.js';

vi.mock('execa');
const mockExeca = vi.mocked(execa) as unknown as ReturnType<typeof vi.fn>;
const ghCalls = () => mockExeca.mock.calls.map((c) => (c[1] as string[]).join(' '));

const plan: Plan = {
  items: [
    { key: 'a', title: 'First', body: 'do a', dependsOn: [] },
    { key: 'b', title: 'Second', body: 'do b', size: 'S', dependsOn: ['a'] },
  ],
  questions: [
    { id: 'q1', question: 'Which?', options: ['x', 'y'], recommended: 'x', why: 'simple' },
  ],
  assumptions: ['none'],
};

beforeEach(() => {
  mockExeca.mockReset();
  let next = 100;
  mockExeca.mockImplementation(async (_cmd: string, args: string[]) => {
    const line = args.join(' ');
    if (args[0] === 'issue' && args[1] === 'create') {
      next++;
      return { stdout: `https://github.com/o/r/issues/${String(next)}\n` };
    }
    if (line.includes('--jq')) return { stdout: `9${line.split('/').pop()?.split(' ')[0]}\n` };
    return { stdout: '' };
  });
});

describe('plan schema file', () => {
  it('is in sync with the zod schema', () => {
    expect(readPlanSchemaFile()).toBe(serializePlanSchema());
  });
});

describe('validatePlan', () => {
  it('accepts a valid plan', () => {
    expect(() => validatePlan(plan)).not.toThrow();
  });

  it('rejects duplicate keys, unknown keys and cycles', () => {
    const item = (key: string, dependsOn: string[]) => ({ key, title: key, body: key, dependsOn });
    const mk = (items: Plan['items']): Plan => ({ ...plan, items });
    expect(() => validatePlan(mk([item('a', []), item('a', [])]))).toThrow(/duplicate/);
    expect(() => validatePlan(mk([item('a', ['zz'])]))).toThrow(/unknown key/);
    expect(() => validatePlan(mk([item('a', ['a'])]))).toThrow(/itself/);
    expect(() => validatePlan(mk([item('a', ['b']), item('b', ['a'])]))).toThrow(
      /block each other/,
    );
  });
});

describe('runPlannerPhase', () => {
  const base = {
    cwd: '/w',
    model: 'm',
    skills: [],
    allow: () => ({ allow: true as const }),
    timeoutMs: 1000,
    issue: { number: 5, title: 'Feat', body: 'feature body' },
    level: 'PBI' as const,
  };
  const harness = (result: unknown): Harness => ({
    runPhase: async () => ({ result, events: [], usage: null }),
  });

  it('returns the validated plan', async () => {
    const out = await runPlannerPhase({ ...base, harness: harness(plan) });
    expect(out.plan).toEqual(plan);
  });

  it('puts the issue into the prompt', async () => {
    const runPhase = vi.fn(async () => ({ result: plan, events: [], usage: null }));
    await runPlannerPhase({ ...base, harness: { runPhase } });
    const prompt = (runPhase.mock.calls[0] as unknown as [{ prompt: string }])[0].prompt;
    expect(prompt).toContain('Plan Feature #5: Feat into PBIs.');
    expect(prompt).toContain('feature body');
  });

  it('rejects an answer that does not match the schema', async () => {
    await expect(
      runPlannerPhase({ ...base, harness: harness({ items: [], questions: [] }) }),
    ).rejects.toThrow();
  });
});

describe('createPlanIssues', () => {
  it('creates PBIs with prefix, parent line and label, links them and sets blockers', async () => {
    const created = await createPlanIssues('o/r', 5, 'PBI', plan);
    expect(created.map((c) => c.number)).toEqual([101, 102]);
    const calls = ghCalls();
    expect(calls[0]).toBe(
      'issue create -R o/r --title [PBI] First --body Parent Feature: #5\n\ndo a --label needs-approval',
    );
    expect(calls).toContain('api -X POST repos/o/r/issues/5/sub_issues -F sub_issue_id=9101');
    expect(calls).toContain('api -X POST repos/o/r/issues/5/sub_issues -F sub_issue_id=9102');
    expect(calls).toContain(
      'api -X POST repos/o/r/issues/102/dependencies/blocked_by -F issue_id=9101',
    );
    expect(calls.filter((c) => c.includes('blocked_by'))).toHaveLength(1);
  });

  it('creates Tasks under a PBI', async () => {
    await createPlanIssues('o/r', 7, 'Task', plan);
    expect(ghCalls()[0]).toContain('--title [Task] First --body Parent PBI: #7');
  });

  it('creates nothing for an invalid plan', async () => {
    await expect(
      createPlanIssues('o/r', 5, 'PBI', {
        ...plan,
        items: [{ key: 'a', title: 'A', body: 'a', dependsOn: ['x'] }],
      }),
    ).rejects.toThrow(/unknown key/);
    expect(mockExeca).not.toHaveBeenCalled();
  });

  it('fails when gh prints no issue url', async () => {
    mockExeca.mockResolvedValue({ stdout: 'oops' });
    await expect(createPlanIssues('o/r', 5, 'PBI', plan)).rejects.toThrow(/no https issue url/);
  });
});
