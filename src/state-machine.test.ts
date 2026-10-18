import { describe, expect, it } from 'vitest';
import type { Review, RunState } from './schemas.js';
import { InvalidTransitionError, isBlocking, type RunEvent, transition } from './state-machine.js';

const STATES: RunState[] = [
  'implementing',
  'gating',
  'reviewing',
  'approved',
  'pr_opened',
  'blocked',
];
const EVENTS: RunEvent['type'][] = [
  'implementation_submitted',
  'gate_passed',
  'gate_failed',
  'review_approved',
  'review_changes',
  'pr_opened',
];

describe('transition table', () => {
  const rows: [RunState, RunEvent['type'], RunState][] = [
    ['implementing', 'implementation_submitted', 'gating'],
    ['gating', 'gate_passed', 'reviewing'],
    ['gating', 'gate_failed', 'implementing'],
    ['reviewing', 'review_approved', 'approved'],
    ['reviewing', 'review_changes', 'implementing'],
    ['approved', 'pr_opened', 'pr_opened'],
  ];
  const roundDelta: Record<string, number> = { gate_failed: 1, review_changes: 1 };

  it.each(rows)('%s + %s -> %s', (state, type, expected) => {
    const next = transition({ state, round: 1 }, { type } as RunEvent, 3);
    expect(next).toEqual({ state: expected, round: 1 + (roundDelta[type] ?? 0) });
  });

  it('rejects every combination not in the table', () => {
    const valid = new Set(rows.map(([s, e]) => `${s}:${e}`));
    let checked = 0;
    for (const state of STATES) {
      for (const type of EVENTS) {
        if (valid.has(`${state}:${type}`)) continue;
        checked++;
        const call = () => transition({ state, round: 1 }, { type } as RunEvent, 3);
        expect(call).toThrow(InvalidTransitionError);
        expect(call).toThrow(`'${type}'`);
        expect(call).toThrow(`'${state}'`);
      }
    }
    expect(checked).toBe(30);
  });

  it('exposes state and event on the error', () => {
    try {
      transition({ state: 'blocked', round: 4 }, { type: 'gate_passed' }, 3);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidTransitionError);
      expect(error).toMatchObject({ name: 'InvalidTransitionError', state: 'blocked' });
      expect((error as InvalidTransitionError).event).toBe('gate_passed');
    }
  });
});

describe('round limit (maxRounds = 3)', () => {
  it.each(['gate_failed', 'review_changes'] as const)('%s at round 2 loops to round 3', (type) => {
    const state: RunState = type === 'gate_failed' ? 'gating' : 'reviewing';
    expect(transition({ state, round: 2 }, { type }, 3)).toEqual({
      state: 'implementing',
      round: 3,
    });
  });

  it.each(['gate_failed', 'review_changes'] as const)('%s at round 3 blocks', (type) => {
    const state: RunState = type === 'gate_failed' ? 'gating' : 'reviewing';
    expect(transition({ state, round: 3 }, { type }, 3)).toEqual({ state: 'blocked', round: 4 });
  });

  it('blocks on the first failure when maxRounds is 1', () => {
    expect(transition({ state: 'gating', round: 1 }, { type: 'gate_failed' }, 1).state).toBe(
      'blocked',
    );
  });
});

describe('isBlocking', () => {
  const review = (
    verdict: Review['verdict'],
    severities: Review['findings'][number]['severity'][],
  ) =>
    ({
      verdict,
      summary: 's',
      findings: severities.map((severity) => ({ severity, file: 'a.ts', summary: 'x' })),
    }) satisfies Review;
  const blocking = ['critical', 'important'] as const;

  it('is true for a changes verdict without findings', () => {
    expect(isBlocking(review('changes', []), [...blocking])).toBe(true);
  });

  it('is false for approve without findings', () => {
    expect(isBlocking(review('approve', []), [...blocking])).toBe(false);
  });

  it('is true for approve with a critical finding', () => {
    expect(isBlocking(review('approve', ['critical']), [...blocking])).toBe(true);
  });

  it('is false for approve with only suggestions', () => {
    expect(isBlocking(review('approve', ['suggestion']), [...blocking])).toBe(false);
  });

  it('respects a custom blocking severity list', () => {
    expect(isBlocking(review('approve', ['important']), ['critical'])).toBe(false);
    expect(isBlocking(review('approve', ['suggestion']), ['suggestion'])).toBe(true);
  });
});
