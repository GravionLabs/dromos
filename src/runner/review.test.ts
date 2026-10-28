import { describe, expect, it } from 'vitest';
import { RunnerConfigSchema } from './config.js';
import type { Harness, PhaseInput } from './harness.js';
import type { ImplementerEvent, PbiSpec } from './implementer.js';
import { findingFingerprint } from './outcome.js';
import { buildPrBody, type GithubOps, type ReviewDeps, runReviewPhase } from './review.js';

const REVIEWING = { kind: 'reviewing', round: 0 } as const;

const pbi: PbiSpec = {
  number: 10,
  title: 'the pbi',
  acceptanceCriteria: '- [ ] criterion A',
  body: 'pbi body\n\n## Technical Notes\nput the finding count in the PR body',
  tasks: [
    { number: 11, title: 'first', body: '', blockedBy: [] },
    { number: 12, title: 'second', body: '', blockedBy: [] },
  ],
};

const finding = { file: 'a.ts', line: 3, title: 'bug', why: 'it breaks' };
const clean = { blocking: [], notes: [] };

function setup(
  answers: unknown[],
  opts: { tests?: boolean[]; output?: string; config?: Record<string, unknown> } = {},
) {
  const inputs: PhaseInput[] = [];
  const queue = [...answers];
  const harness: Harness = {
    async runPhase(input) {
      inputs.push(input);
      const result = queue.shift();
      if (result instanceof Error) throw result;
      return { result, events: [], usage: { inputTokens: 1, outputTokens: 2, costUsd: null } };
    },
  };
  const events: ImplementerEvent[] = [];
  const prs: { input: Parameters<GithubOps['createPr']>[1] }[] = [];
  const comments: { number: number; body: string }[] = [];
  const tests = [...(opts.tests ?? [true])];
  const deps: ReviewDeps = {
    harness,
    harnessInfo: { id: 'claude', name: 'claude', version: null, sdk: null },
    config: RunnerConfigSchema.parse(opts.config ?? {}),
    cwd: '/wt',
    skillDirs: [],
    allow: () => ({ allow: true }),
    timeoutMs: 1000,
    runTests: async () => ({
      passed: tests.shift() ?? true,
      output: opts.output ?? 'a\nb\nFAIL c',
    }),
    emit: (e) => events.push(e),
    repo: 'o/r',
    base: 'release/next',
    branch: 'feat/10-the-pbi',
    github: {
      createPr: async (_repo, input) => {
        prs.push({ input });
        return { number: 77, url: 'https://github.com/o/r/pull/77' };
      },
      comment: async (_repo, number, body) => {
        comments.push({ number, body });
      },
    },
    listCommits: async () => [
      { sha: 'aaaaaaa1111', subject: 'feat: first (#11)' },
      { sha: 'bbbbbbb2222', subject: 'feat: other (#110)' },
    ],
  };
  return { deps, inputs, events, prs, comments };
}

describe('runReviewPhase', () => {
  it('opens a ready PR after a clean review and comments the notes', async () => {
    const s = setup([{ blocking: [], notes: ['nit'] }]);
    const out = await runReviewPhase(s.deps, pbi, REVIEWING);
    expect(out.state).toEqual({ kind: 'pr_opened' });
    expect(out.pr).toEqual({ number: 77, url: 'https://github.com/o/r/pull/77', draft: false });
    expect(s.inputs).toHaveLength(1);
    expect(s.inputs[0]?.model).toBe('opus');
    expect(s.inputs[0]?.prompt).toContain('git diff origin/release/next...HEAD');
    expect(s.inputs[0]?.prompt).toContain('put the finding count in the PR body');
    expect(s.inputs[0]?.prompt).toContain('against the code that emits or consumes them');
    expect(s.inputs[0]?.prompt).toContain('cannot verify from this repository is blocking');
    expect(s.prs[0]?.input.draft).toBe(false);
    expect(s.prs[0]?.input.body).toContain('Closes #10');
    expect(s.comments).toEqual([{ number: 77, body: '## Review notes\n\n- nit' }]);
  });

  it('posts no comment without notes', async () => {
    const s = setup([clean]);
    await runReviewPhase(s.deps, pbi, REVIEWING);
    expect(s.comments).toEqual([]);
  });

  it('formats the fix round before the tests', async () => {
    const s = setup([
      { blocking: [finding], notes: [] },
      { status: 'done', summary: 'fixed' },
    ]);
    const order: string[] = [];
    const runTests = s.deps.runTests;
    const out = await runReviewPhase(
      {
        ...s.deps,
        config: RunnerConfigSchema.parse({ format: 'fmt' }),
        runTests: async (c, cwd, timeoutMs) => {
          order.push('tests');
          return (runTests as NonNullable<typeof runTests>)(c, cwd, timeoutMs);
        },
        runFormat: async () => {
          order.push('format');
          return { passed: true, output: '' };
        },
        formatGit: { changedFiles: async () => ['a.ts'], commitAll: async () => true },
      },
      pbi,
      REVIEWING,
    );
    expect(order).toEqual(['format', 'tests']);
    expect(out.state).toEqual({ kind: 'pr_opened' });
  });

  it('runs one fix round with the round-2 model and the findings, then tests and PR', async () => {
    const s = setup([
      { blocking: [finding], notes: [] },
      { status: 'done', summary: 'fixed' },
    ]);
    const out = await runReviewPhase(s.deps, pbi, REVIEWING);
    expect(out.state).toEqual({ kind: 'pr_opened' });
    expect(s.inputs).toHaveLength(2);
    expect(s.inputs[1]?.model).toBe('opus');
    expect(s.inputs[1]?.prompt).toContain('a.ts:3 bug: it breaks');
    expect(out.pr?.draft).toBe(false);
    expect(s.events.map((e) => e.type)).toContain('fix.finished');
  });

  it('emits fix round, test result and fixed finding events for a successful fix round', async () => {
    const s = setup(
      [
        { blocking: [{ ...finding, rule: 'null-check' }], notes: [] },
        { status: 'done', summary: 'fixed' },
      ],
      { output: 'Tests  1 failed | 4 passed (5)\n FAIL  a.test.ts > bug' },
    );
    await runReviewPhase(s.deps, pbi, REVIEWING);
    const outcome = s.events.filter((e) => e.type.startsWith('outcome.'));
    expect(outcome).toEqual([
      { type: 'outcome.fixRound', data: { cause: 'review_findings' } },
      {
        type: 'outcome.tests',
        data: { passed: 4, failed: 1, failures: ['a.test.ts > bug'] },
      },
      {
        type: 'outcome.finding',
        data: {
          fingerprint: findingFingerprint({ file: 'a.ts', rule: 'null-check', title: 'bug' }),
          blocking: true,
          fixed: true,
        },
      },
    ]);
  });

  it('reports the findings as not fixed when the tests stay red', async () => {
    const s = setup(
      [
        { blocking: [finding], notes: [] },
        { status: 'done', summary: 'fixed' },
      ],
      { tests: [false] },
    );
    await runReviewPhase(s.deps, pbi, REVIEWING);
    expect(s.events.filter((e) => e.type === 'outcome.finding')).toEqual([
      {
        type: 'outcome.finding',
        data: { fingerprint: findingFingerprint(finding), blocking: true, fixed: false },
      },
    ]);
  });

  it('emits no outcome events for a clean review', async () => {
    const s = setup([clean]);
    await runReviewPhase(s.deps, pbi, REVIEWING);
    expect(s.events.filter((e) => e.type.startsWith('outcome.'))).toEqual([]);
  });

  it('opens a draft PR when tests are red after the fix round', async () => {
    const s = setup(
      [
        { blocking: [finding], notes: [] },
        { status: 'done', summary: 'fixed' },
      ],
      { tests: [false] },
    );
    const out = await runReviewPhase(s.deps, pbi, REVIEWING);
    expect(out.state.kind).toBe('blocked');
    expect(out.pr?.draft).toBe(true);
    expect(s.prs[0]?.input.draft).toBe(true);
    expect(s.prs[0]?.input.body).toContain('**failed**');
    expect(s.prs[0]?.input.body).toContain('FAIL c');
    expect(s.prs[0]?.input.body).toContain('Unresolved finding a.ts:3 bug');
  });

  it('blocks without a PR when the reviewer output does not match the schema', async () => {
    const s = setup([{ blocking: 'x' }]);
    const out = await runReviewPhase(s.deps, pbi, REVIEWING);
    expect(out.state.kind).toBe('blocked');
    expect(out.pr).toBeUndefined();
    expect(s.prs).toEqual([]);
    expect(s.events.map((e) => e.type)).toContain('phase.failed');
  });

  it('blocks without a PR when the fix session fails', async () => {
    const s = setup([
      { blocking: [finding], notes: [] },
      { status: 'failed', summary: 'cannot' },
    ]);
    const out = await runReviewPhase(s.deps, pbi, REVIEWING);
    expect(out.state).toEqual({ kind: 'blocked', reason: 'fix round failed: cannot' });
    expect(s.prs).toEqual([]);
  });

  it('blocks on findings when no fix round is allowed', async () => {
    const s = setup([{ blocking: [finding], notes: [] }], { config: { maxFixRounds: 0 } });
    const out = await runReviewPhase(s.deps, pbi, REVIEWING);
    expect(out.state.kind).toBe('blocked');
    expect(s.inputs).toHaveLength(1);
    expect(s.prs).toEqual([]);
    expect(s.events.filter((e) => e.type === 'outcome.finding')).toHaveLength(1);
    expect(s.events.map((e) => e.type)).not.toContain('outcome.fixRound');
  });
});

describe('buildPrBody', () => {
  const base = {
    pbi,
    commits: [
      { sha: 'aaaaaaa1111', subject: 'feat: first (#11)' },
      { sha: 'bbbbbbb2222', subject: 'feat: other (#110)' },
    ],
    unresolved: [],
    notes: [],
    testsPassed: true,
    testCommand: 'npm test',
  };

  it('lists Tasks with commit SHAs and names undelivered Tasks', () => {
    const body = buildPrBody(base);
    expect(body).toContain('- [x] #11 first (aaaaaaa)');
    expect(body).toContain('- [ ] #12 second');
    expect(body).toContain('## Not delivered\n\n- Task #12 second: no commit');
    expect(body).toContain('## Review notes\n\nNone.');
    expect(body).toContain('## Test result\n\n`npm test`: passed');
  });

  it('says nothing was left out when all Tasks have commits', () => {
    const body = buildPrBody({
      ...base,
      commits: [
        { sha: 'aaaaaaa1111', subject: 'feat: first (#11)' },
        { sha: 'ccccccc3333', subject: 'feat: second (#12)' },
      ],
    });
    expect(body).toContain('## Not delivered\n\nNothing.');
  });
});
