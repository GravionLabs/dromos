import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db.js';
import type { RunnerIssue } from './github.js';
import type { Harness } from './harness.js';
import type { Plan, PlanLevel } from './planner.js';
import { ttySelectPrompt } from './questions.js';
import { EXIT_DONE, EXIT_ERROR } from './run-pbi.js';
import {
  EXIT_NEEDS_DECISION,
  planLevel,
  planPath,
  type RunPlanEvent,
  type RunPlanOps,
  runPlan,
} from './run-plan.js';

const feature: RunnerIssue = {
  number: 40,
  title: '[Feature] feat: store',
  body: 'feature body',
  labels: [],
  subIssues: [],
  blockedBy: [],
};

const plan: Plan = {
  items: [{ key: 'a', title: 'First', body: 'do a', dependsOn: [] }],
  questions: [
    { id: 'q1', question: 'Which db?', options: ['sqlite', 'pg'], recommended: 'sqlite', why: 'w' },
    { id: 'q2', question: 'Which ui?', options: ['cli', 'web'], recommended: 'cli', why: 'w' },
  ],
  assumptions: ['single user'],
};

interface Created {
  parent: number;
  level: PlanLevel;
  plan: Plan;
  assumptions: string[];
}

function setup(answer: unknown = plan, ops: Partial<RunPlanOps> = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'dromos-plan-'));
  const events: RunPlanEvent[] = [];
  const created: Created[] = [];
  const gh: string[] = [];
  const harness: Harness & { version(): Promise<string | null> } = {
    version: async () => '1.0.0',
    runPhase: async () => {
      if (answer instanceof Error) throw answer;
      return { result: answer, events: [], usage: null };
    },
  };
  const db = openDb(':memory:');
  const run = (resolve: Parameters<typeof runPlan>[0]['resolve'] = {}) =>
    runPlan({
      issue: 40,
      repo,
      resolve,
      db,
      emit: (e) => events.push(e),
      ops: {
        repoSlug: async () => 'o/r',
        readIssue: async () => feature,
        makeHarness: () => harness,
        readComments: async () => [],
        comment: async (_slug, n, body) => {
          gh.push(`comment ${String(n)}\n${body}`);
        },
        addLabel: async (_slug, n, label) => {
          gh.push(`add ${String(n)} ${label}`);
        },
        removeLabel: async (_slug, n, label) => {
          gh.push(`remove ${String(n)} ${label}`);
        },
        createIssues: async (_slug, parent, level, p, assumptions = []) => {
          created.push({ parent, level, plan: p, assumptions });
          return [{ key: 'a', number: 41, url: 'https://github.com/o/r/issues/41' }];
        },
        ...ops,
      },
    });
  const finished = () => events.find((e) => e.type === 'phase.finished');
  const last = () => events.at(-1);
  const savedPlan = () => JSON.parse(readFileSync(planPath(repo, 40), 'utf8')) as Plan;
  return { repo, events, created, gh, db, run, finished, last, savedPlan };
}

describe('planLevel', () => {
  it('plans a Feature into PBIs and a PBI into Tasks', () => {
    expect(planLevel('[Feature] feat: x')).toBe('PBI');
    expect(planLevel('[PBI] feat: x')).toBe('Task');
  });

  it('rejects other titles', () => {
    expect(() => planLevel('[Task] x')).toThrow(/\[Feature\] or \[PBI\]/);
  });
});

describe('runPlan', () => {
  it('asks each question on a fake TTY, Enter takes the recommendation', async () => {
    const s = setup();
    const written: string[] = [];
    const replies = ['', '2'];
    const prompt = ttySelectPrompt(
      { write: (t) => written.push(t) },
      async () => replies.shift() ?? '',
    );
    expect(await s.run({ prompt })).toBe(EXIT_DONE);
    expect(written.filter((w) => w.includes('[Enter = '))).toHaveLength(2);
    expect(s.finished()).toMatchObject({ data: { phase: 'planner', unansweredQuestions: 0 } });
    expect(s.savedPlan().assumptions).toEqual(['single user']);
    expect(s.created).toEqual([
      { parent: 40, level: 'PBI', plan: s.savedPlan(), assumptions: ['single user'] },
    ]);
  });

  it('raises one APPROVAL attention per created issue with [Level] title and no pr', async () => {
    const s = setup();
    expect(await s.run({ assumeRecommended: true })).toBe(EXIT_DONE);
    expect(s.events.filter((e) => e.type === 'attention')).toEqual([
      {
        type: 'attention',
        data: { kind: 'APPROVAL', summary: '[PBI] First', pr: null },
        issue: 41,
      },
    ]);
    const open = s.db.listAttention({ state: 'open', issue: 41, limit: 10 });
    expect(open).toMatchObject([{ kind: 'APPROVAL', summary: '[PBI] First', issue: 41 }]);
    expect(s.db.queryEvents({ repo: 'o/r', issue: 41, limit: 10 }).events).toHaveLength(1);
  });

  it('raises no APPROVAL attention while questions are open', async () => {
    const s = setup();
    await s.run({});
    const attentions = s.db.listAttention({ limit: 10 });
    expect(attentions.filter((a) => a.kind === 'APPROVAL')).toEqual([]);
  });

  it('emits outcome.questions with the count and the taken recommendations', async () => {
    const s = setup();
    expect(await s.run({ assumeRecommended: true })).toBe(EXIT_DONE);
    const event = s.events.find((e) => e.type === 'outcome.questions');
    expect(event).toEqual({ type: 'outcome.questions', data: { count: 2, assumed: 2 } });
    expect(s.events.indexOf(event as RunPlanEvent)).toBeLessThan(
      s.events.findIndex((e) => e.type === 'phase.finished'),
    );
    const stored = s.db.queryEvents({ issue: 40, limit: 20 }).events;
    expect(stored.some((e) => e.kind === 'outcome.questions')).toBe(true);
  });

  it('answers by --answer without a prompt', async () => {
    const s = setup();
    const written: string[] = [];
    const prompt = ttySelectPrompt({ write: (t) => written.push(t) }, async () => '');
    const answers = new Map([
      ['q1', 'pg'],
      ['q2', 'web'],
    ]);
    expect(await s.run({ answers, prompt })).toBe(EXIT_DONE);
    expect(written).toEqual([]);
    expect(s.last()).toMatchObject({ type: 'run.finished', outcome: 'planned' });
  });

  it('writes taken recommendations into plan.json and every created issue', async () => {
    const s = setup();
    expect(await s.run({ assumeRecommended: true })).toBe(EXIT_DONE);
    const expected = ['single user', 'Which db? Assumed: sqlite', 'Which ui? Assumed: cli'];
    expect(s.savedPlan().assumptions).toEqual(expected);
    expect(s.created[0]?.assumptions).toEqual(expected);
    expect(s.last()).toMatchObject({
      type: 'run.finished',
      outcome: 'planned',
      plan: planPath(s.repo, 40),
      issues: [{ key: 'a', number: 41 }],
    });
  });

  it('counts unanswered questions in phase.finished and creates no issue', async () => {
    const s = setup();
    expect(await s.run({ answers: new Map([['q1', 'pg']]) })).toBe(EXIT_NEEDS_DECISION);
    expect(s.finished()).toMatchObject({ data: { unansweredQuestions: 1 } });
    expect(s.created).toEqual([]);
    expect(s.last()).toMatchObject({ type: 'run.finished', outcome: 'questions_open' });
    expect((s.last() as { reason: string }).reason).toMatch(/1 open question\(s\): q2/);
  });

  it('headless: one comment with a section per question, needs-decision, attention, exit 2', async () => {
    const s = setup();
    expect(await s.run()).toBe(2);
    expect(s.created).toEqual([]);
    const posted = s.gh.filter((g) => g.startsWith('comment'));
    expect(posted).toHaveLength(1);
    const body = posted[0] as string;
    expect(body).toContain('- **First**');
    expect(body).toContain('### q1: Which db?');
    expect(body).toContain('- sqlite (recommended)\n- pg');
    expect(body).toContain('### q2: Which ui?');
    expect(body).toContain('Recommendation: cli.');
    expect(s.gh).toContain('add 40 needs-decision');
    expect(s.events.find((e) => e.type === 'attention')).toMatchObject({
      data: { kind: 'QUESTION', pr: null },
    });
    const stored = s.db.queryEvents({ issue: 40, limit: 10 }).events;
    expect(stored.some((e) => e.kind === 'attention')).toBe(true);
  });

  it('does not post a comment with --assume-recommended', async () => {
    const s = setup();
    expect(await s.run({ assumeRecommended: true })).toBe(EXIT_DONE);
    expect(s.gh).toEqual([]);
  });

  it('reads /answer comments, removes needs-decision and creates the issues', async () => {
    const s = setup(plan, {
      readIssue: async () => ({ ...feature, labels: ['needs-decision'] }),
      readComments: async () => [
        'Answer with `/answer q1 <value>`.',
        '/answer q1 pg\n/answer q2 web',
        '/answer q2 cli',
      ],
    });
    expect(await s.run()).toBe(EXIT_DONE);
    expect(s.gh).toEqual(['remove 40 needs-decision']);
    expect(s.created).toHaveLength(1);
    expect(s.savedPlan().assumptions).toEqual(['single user']);
  });

  it('keeps asking for questions the comments leave open', async () => {
    const s = setup(plan, { readComments: async () => ['/answer q1 pg'] });
    expect(await s.run()).toBe(EXIT_NEEDS_DECISION);
    expect(s.gh.find((g) => g.startsWith('comment'))).not.toContain('### q1');
  });

  it('ignores comment answers to unknown ids; flags win over comments', async () => {
    const s = setup(plan, {
      readComments: async () => ['/answer zz 1\n/answer q1 pg\n/answer q2 web'],
    });
    expect(await s.run({ answers: new Map([['q2', 'cli']]) })).toBe(EXIT_DONE);
  });

  it('exits 3 when a commented answer is not an option', async () => {
    const s = setup(plan, { readComments: async () => ['/answer q1 typo'] });
    expect(await s.run()).toBe(EXIT_ERROR);
    expect(s.created).toEqual([]);
  });

  it('stores phase.finished with the count on the bus', async () => {
    const s = setup();
    await s.run({ assumeRecommended: true });
    const stored = s.db.queryEvents({ issue: 40, limit: 10 }).events;
    const done = stored.find((e) => e.kind === 'phase.finished');
    expect(done?.data).toMatchObject({ phase: 'planner', unansweredQuestions: 0 });
  });

  it('reports 0 unanswered for a plan without questions', async () => {
    const s = setup({ ...plan, questions: [] });
    expect(await s.run()).toBe(EXIT_DONE);
    expect(s.finished()).toMatchObject({ data: { unansweredQuestions: 0 } });
  });

  it('fails the phase when the planner session fails', async () => {
    const s = setup(new Error('session crashed'));
    expect(await s.run({ assumeRecommended: true })).toBe(EXIT_ERROR);
    expect(s.events.map((e) => e.type)).toEqual(['phase.started', 'phase.failed', 'run.finished']);
    expect(s.last()).toMatchObject({ outcome: 'error', reason: 'session crashed' });
  });

  it('exits 3 on an --answer value that is not an option, before creating issues', async () => {
    const s = setup();
    expect(await s.run({ answers: new Map([['q1', 'typo']]) })).toBe(EXIT_ERROR);
    expect(s.created).toEqual([]);
    expect(s.last()).toMatchObject({
      outcome: 'error',
      reason: expect.stringMatching(/not an option/),
    });
  });

  it('exits 3 when the issue is not of the kind asked for (dromos plan pbi on a Feature)', async () => {
    const s = setup();
    const events: RunPlanEvent[] = [];
    const code = await runPlan({
      issue: 40,
      repo: s.repo,
      kind: 'PBI',
      emit: (e) => events.push(e),
      ops: { repoSlug: async () => 'o/r', readIssue: async () => feature },
    });
    expect(code).toBe(EXIT_ERROR);
    expect(events).toEqual([
      {
        type: 'run.finished',
        outcome: 'error',
        reason: "#40 is not a PBI: '[Feature] feat: store'",
      },
    ]);
  });

  it('exits 3 for an issue that is neither a Feature nor a PBI', async () => {
    const s = setup(plan, { readIssue: async () => ({ ...feature, title: '[Task] x' }) });
    expect(await s.run()).toBe(EXIT_ERROR);
    expect(s.events.map((e) => e.type)).toEqual(['run.finished']);
  });
});
