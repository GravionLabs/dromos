import { describe, expect, it } from 'vitest';
import {
  INITIAL_STATE,
  isTerminal,
  type RunInput,
  type RunState,
  transition,
} from './state-machine.js';

function run(inputs: RunInput[], maxFixRounds = 1): RunState {
  return inputs.reduce<RunState>((s, i) => transition(s, i, maxFixRounds).state, INITIAL_STATE);
}

describe('transition', () => {
  it('selected --start--> implementing(0)', () => {
    expect(transition(INITIAL_STATE, { type: 'start' }, 1)).toEqual({
      state: { kind: 'implementing', round: 0 },
      event: { type: 'run.started' },
    });
  });

  it('implementing --implemented--> testing', () => {
    expect(transition({ kind: 'implementing', round: 0 }, { type: 'implemented' }, 1)).toEqual({
      state: { kind: 'testing', round: 0 },
      event: { type: 'implement.finished', round: 0 },
    });
  });

  it('testing --tests_passed--> reviewing after the first implementation', () => {
    expect(transition({ kind: 'testing', round: 0 }, { type: 'tests_passed' }, 1)).toEqual({
      state: { kind: 'reviewing', round: 0 },
      event: { type: 'tests.passed', round: 0 },
    });
  });

  it('testing --tests_passed--> pr_opened after the last fix round', () => {
    expect(transition({ kind: 'testing', round: 1 }, { type: 'tests_passed' }, 1)).toEqual({
      state: { kind: 'pr_opened' },
      event: { type: 'tests.passed', round: 1 },
    });
  });

  it('testing --tests_passed--> reviewing after a fix while rounds remain', () => {
    expect(transition({ kind: 'testing', round: 1 }, { type: 'tests_passed' }, 2).state).toEqual({
      kind: 'reviewing',
      round: 1,
    });
  });

  it('testing --tests_failed--> blocked', () => {
    expect(
      transition({ kind: 'testing', round: 0 }, { type: 'tests_failed', summary: '2 red' }, 1),
    ).toEqual({
      state: { kind: 'blocked', reason: 'tests failed in round 0: 2 red' },
      event: { type: 'run.blocked', reason: 'tests failed in round 0: 2 red' },
    });
  });

  it('reviewing --review_clean--> pr_opened', () => {
    expect(transition({ kind: 'reviewing', round: 0 }, { type: 'review_clean' }, 1)).toEqual({
      state: { kind: 'pr_opened' },
      event: { type: 'review.clean', round: 0 },
    });
  });

  it('reviewing --review_findings--> fixing(round + 1)', () => {
    expect(
      transition({ kind: 'reviewing', round: 0 }, { type: 'review_findings', count: 3 }, 1),
    ).toEqual({
      state: { kind: 'fixing', round: 1 },
      event: { type: 'review.findings', round: 0, count: 3 },
    });
  });

  it('fixing --fixed--> testing', () => {
    expect(transition({ kind: 'fixing', round: 1 }, { type: 'fixed' }, 1)).toEqual({
      state: { kind: 'testing', round: 1 },
      event: { type: 'fix.finished', round: 1 },
    });
  });

  it.each<[string, RunState]>([
    ['selected', { kind: 'selected' }],
    ['implementing', { kind: 'implementing', round: 0 }],
    ['testing', { kind: 'testing', round: 0 }],
    ['reviewing', { kind: 'reviewing', round: 0 }],
    ['fixing', { kind: 'fixing', round: 1 }],
  ])('%s --abort--> blocked(reason)', (_name, state) => {
    expect(transition(state, { type: 'abort', reason: 'budget' }, 1)).toEqual({
      state: { kind: 'blocked', reason: 'budget' },
      event: { type: 'run.blocked', reason: 'budget' },
    });
  });

  it('blocks on an input that does not fit the state', () => {
    const t = transition({ kind: 'selected' }, { type: 'fixed' }, 1);
    expect(t.state).toEqual({ kind: 'blocked', reason: 'unexpected fixed in state selected' });
    expect(t.event.type).toBe('run.blocked');
  });

  it.each<RunState>([{ kind: 'pr_opened' }, { kind: 'blocked', reason: 'x' }])(
    'rejects any input in terminal state %o',
    (state) => {
      expect(isTerminal(state)).toBe(true);
      expect(() => transition(state, { type: 'start' }, 1)).toThrow(/already/);
    },
  );
});

describe('round limit', () => {
  const happyStart: RunInput[] = [
    { type: 'start' },
    { type: 'implemented' },
    { type: 'tests_passed' },
  ];
  const fixRound: RunInput[] = [
    { type: 'review_findings', count: 1 },
    { type: 'fixed' },
    { type: 'tests_passed' },
  ];

  it('opens the PR after one fix round with the default limit of 1', () => {
    expect(run([...happyStart, ...fixRound])).toEqual({ kind: 'pr_opened' });
  });

  it('allows a second review and fix round when maxFixRounds is 2', () => {
    expect(run([...happyStart, ...fixRound], 2)).toEqual({ kind: 'reviewing', round: 1 });
    expect(run([...happyStart, ...fixRound, ...fixRound], 2)).toEqual({ kind: 'pr_opened' });
  });

  it('blocks on findings when maxFixRounds is 0', () => {
    expect(run([...happyStart, { type: 'review_findings', count: 2 }], 0)).toEqual({
      kind: 'blocked',
      reason: '2 review findings remain after 0 fix round(s)',
    });
  });

  it('never exceeds maxFixRounds', () => {
    for (const max of [0, 1, 2, 3]) {
      let state: RunState = INITIAL_STATE;
      let maxRound = 0;
      const script: RunInput[] = [{ type: 'start' }, { type: 'implemented' }];
      for (let i = 0; i < 20 && !isTerminal(state); i++) {
        const input: RunInput =
          i < script.length
            ? (script[i] as RunInput)
            : state.kind === 'testing'
              ? { type: 'tests_passed' }
              : state.kind === 'reviewing'
                ? { type: 'review_findings', count: 1 }
                : { type: 'fixed' };
        state = transition(state, input, max).state;
        if (state.kind === 'fixing') maxRound = Math.max(maxRound, state.round);
      }
      expect(isTerminal(state)).toBe(true);
      expect(maxRound).toBeLessThanOrEqual(max);
    }
  });
});
