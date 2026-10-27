import { describe, expect, it } from 'vitest';
import { BusEventSchema } from '../events/schema.js';
import { issueBody, type Plan } from './planner.js';
import {
  parseAnswerFlags,
  resolveQuestions,
  ttySelectPrompt,
  withAssumptions,
} from './questions.js';

const plan: Plan = {
  items: [{ key: 'a', title: 'First', body: 'do a', dependsOn: [] }],
  questions: [
    { id: 'q1', question: 'Which db?', options: ['sqlite', 'pg'], recommended: 'sqlite', why: 'w' },
    { id: 'q2', question: 'Which ui?', options: ['cli', 'web'], recommended: 'cli', why: 'w' },
  ],
  assumptions: ['single user'],
};

/** A fake TTY: collects what is written, replies with the scripted lines. */
function fakeTty(replies: string[]) {
  const written: string[] = [];
  const queue = [...replies];
  return {
    written,
    prompt: ttySelectPrompt({ write: (t) => written.push(t) }, async () => queue.shift() ?? ''),
  };
}

describe('parseAnswerFlags', () => {
  it('parses id=value and keeps "=" inside the value', () => {
    expect([...parseAnswerFlags(['q1=pg', 'q2=a=b'])]).toEqual([
      ['q1', 'pg'],
      ['q2', 'a=b'],
    ]);
  });

  it.each(['q1', '=x', 'q1='])('rejects %s', (flag) => {
    expect(() => parseAnswerFlags([flag])).toThrow(/<id>=<value>/);
  });
});

describe('resolveQuestions', () => {
  it('answers by flag without a prompt', async () => {
    const tty = fakeTty([]);
    const r = await resolveQuestions(plan, {
      answers: new Map([
        ['q1', 'pg'],
        ['q2', 'web'],
      ]),
      prompt: tty.prompt,
    });
    expect(r.answered.map((a) => a.answer)).toEqual(['pg', 'web']);
    expect(r.unanswered).toEqual([]);
    expect(tty.written).toEqual([]);
  });

  it('asks only what a flag did not answer', async () => {
    const tty = fakeTty(['2']);
    const r = await resolveQuestions(plan, {
      answers: new Map([['q1', 'pg']]),
      prompt: tty.prompt,
    });
    expect(r.answered.map((a) => [a.id, a.answer])).toEqual([
      ['q1', 'pg'],
      ['q2', 'web'],
    ]);
  });

  it('rejects an answer for an unknown question', async () => {
    await expect(resolveQuestions(plan, { answers: new Map([['zz', 'x']]) })).rejects.toThrow(
      /unknown question 'zz'/,
    );
  });

  it('takes every recommendation with assumeRecommended', async () => {
    const r = await resolveQuestions(plan, { assumeRecommended: true });
    expect(r.answered.map((a) => [a.answer, a.assumed])).toEqual([
      ['sqlite', true],
      ['cli', true],
    ]);
    expect(r.unanswered).toEqual([]);
  });

  it('leaves questions unanswered without TTY, flags or assume', async () => {
    const r = await resolveQuestions(plan, { answers: new Map([['q1', 'pg']]) });
    expect(r.unanswered.map((q) => q.id)).toEqual(['q2']);
  });
});

describe('ttySelectPrompt', () => {
  it('Enter takes the recommendation', async () => {
    const tty = fakeTty(['']);
    expect(await tty.prompt(plan.questions[0] as Plan['questions'][0])).toBe('sqlite');
    expect(tty.written[0]).toContain('1) sqlite (recommended)');
    expect(tty.written[0]).toContain('2) pg');
  });

  it('accepts a number or the option text', async () => {
    const q = plan.questions[0] as Plan['questions'][0];
    expect(await fakeTty(['2']).prompt(q)).toBe('pg');
    expect(await fakeTty(['pg']).prompt(q)).toBe('pg');
  });

  it('asks again after an invalid reply', async () => {
    const tty = fakeTty(['9', 'nope', '1']);
    expect(await tty.prompt(plan.questions[0] as Plan['questions'][0])).toBe('sqlite');
    expect(tty.written.filter((t) => t.includes('is not an option'))).toHaveLength(2);
  });
});

describe('assumptions', () => {
  it('writes taken recommendations into the plan, after the planner own', async () => {
    const r = await resolveQuestions(plan, { assumeRecommended: true });
    expect(withAssumptions(plan, r).assumptions).toEqual([
      'single user',
      'Which db? Assumed: sqlite',
      'Which ui? Assumed: cli',
    ]);
  });

  it('does not list answered questions as assumptions', async () => {
    const r = await resolveQuestions(plan, { answers: new Map([['q1', 'pg']]) });
    expect(withAssumptions(plan, r).assumptions).toEqual(['single user']);
  });

  it('puts them under ## Assumptions in the issue body', () => {
    const item = plan.items[0] as Plan['items'][0];
    expect(issueBody('PBI', 5, item, ['x', 'y'])).toBe(
      'Parent Feature: #5\n\ndo a\n\n## Assumptions\n\n- x\n- y',
    );
    expect(issueBody('PBI', 5, item)).toBe('Parent Feature: #5\n\ndo a');
  });
});

describe('phase.finished unansweredQuestions', () => {
  const event = (extra: Record<string, unknown>) => ({
    id: 1,
    type: 'phase.finished',
    at: '2026-10-27T10:00:00.000Z',
    source: 'dromos',
    agentId: null,
    issue: 227,
    runId: 'run-227',
    data: {
      phase: 'planner',
      harness: { name: 'claude', version: null, sdk: null },
      model: 'm',
      durationMs: 1,
      usage: null,
      ...extra,
    },
  });

  it('accepts the count', () => {
    expect(BusEventSchema.safeParse(event({ unansweredQuestions: 2 })).success).toBe(true);
  });

  it('rejects a negative count', () => {
    expect(BusEventSchema.safeParse(event({ unansweredQuestions: -1 })).success).toBe(false);
  });
});
