import { describe, expect, it } from 'vitest';
import type { Review, RunState, Severity } from './schemas.js';
import { InvalidTransitionError, isBlocking, type RunEvent, transition } from './state-machine.js';

type EventType = RunEvent['type'];

const STATES: RunState[] = [
  'implementing',
  'gating',
  'reviewing',
  'approved',
  'pr_opened',
  'blocked',
];
const EVENTS: EventType[] = [
  'implementation_submitted',
  'gate_passed',
  'gate_failed',
  'review_approved',
  'review_changes',
  'pr_opened',
];

const ev = (type: EventType): RunEvent => ({ type }) as RunEvent;

// [from, event, expected state, expected round when starting at round 1]
const ROWS: [RunState, EventType, RunState, number][] = [
  ['implementing', 'implementation_submitted', 'gating', 1],
  ['gating', 'gate_passed', 'reviewing', 1],
  ['gating', 'gate_failed', 'implementing', 2],
  ['reviewing', 'review_approved', 'approved', 1],
  ['reviewing', 'review_changes', 'implementing', 2],
  ['approved', 'pr_opened', 'pr_opened', 1],
];

const VALID = new Set(ROWS.map(([s, e]) => `${s}:${e}`));
const INVALID: [RunState, EventType][] = STATES.flatMap((s) =>
  EVENTS.filter((e) => !VALID.has(`${s}:${e}`)).map((e): [RunState, EventType] => [s, e]),
);

describe('transition table', () => {
  it.each(ROWS)('%s + %s -> %s (round %i from round 1)', (state, type, expected, round) => {
    expect(transition({ state, round: 1 }, ev(type), 3)).toEqual({ state: expected, round });
  });

  it.each(INVALID)('rejects %s + %s', (state, type) => {
    const call = () => transition({ state, round: 1 }, ev(type), 3);
    expect(call).toThrow(InvalidTransitionError);
    expect(call).toThrow(`'${type}'`);
    expect(call).toThrow(`'${state}'`);
  });

  it('covers every state x event pair exactly once', () => {
    expect(INVALID.length + ROWS.length).toBe(STATES.length * EVENTS.length);
  });

  it('exposes state and event on the error', () => {
    try {
      transition({ state: 'blocked', round: 4 }, ev('gate_passed'), 3);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidTransitionError);
      expect(error).toMatchObject({
        name: 'InvalidTransitionError',
        state: 'blocked',
        event: 'gate_passed',
      });
    }
  });

  it('does not mutate the input and returns a new object', () => {
    const run = { state: 'implementing' as RunState, round: 2 };
    const next = transition(run, ev('implementation_submitted'), 3);
    expect(run).toEqual({ state: 'implementing', round: 2 });
    expect(next).not.toBe(run);
  });
});

describe('round limit', () => {
  const FAILURES: [EventType, RunState][] = [
    ['gate_failed', 'gating'],
    ['review_changes', 'reviewing'],
  ];

  it.each(FAILURES)('%s at round 2 (max 3) loops to round 3', (type, state) => {
    expect(transition({ state, round: 2 }, ev(type), 3)).toEqual({
      state: 'implementing',
      round: 3,
    });
  });

  it.each(FAILURES)('%s at round 3 (max 3) blocks', (type, state) => {
    expect(transition({ state, round: 3 }, ev(type), 3)).toEqual({ state: 'blocked', round: 4 });
  });

  it.each(FAILURES)('%s at round 1 (max 1) blocks', (type, state) => {
    expect(transition({ state, round: 1 }, ev(type), 1)).toEqual({ state: 'blocked', round: 2 });
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects invalid maxRounds %s', (maxRounds) => {
    expect(() => transition({ state: 'gating', round: 1 }, ev('gate_failed'), maxRounds)).toThrow(
      /maxRounds/,
    );
  });
});

describe('isBlocking', () => {
  const review = (verdict: Review['verdict'], severities: Severity[]): Review => ({
    verdict,
    summary: 's',
    findings: severities.map((severity) => ({ severity, file: 'a.ts', summary: 'x' })),
  });
  const blocking: Severity[] = ['critical', 'important'];

  it('is true for a changes verdict without findings', () => {
    expect(isBlocking(review('changes', []), blocking)).toBe(true);
  });

  it('is true for a changes verdict even with no blocking severities configured', () => {
    expect(isBlocking(review('changes', []), [])).toBe(true);
  });

  it('is false for approve without findings', () => {
    expect(isBlocking(review('approve', []), blocking)).toBe(false);
  });

  it('is true for approve with a critical finding', () => {
    expect(isBlocking(review('approve', ['critical']), blocking)).toBe(true);
  });

  it('is true for approve with mixed suggestion and critical findings', () => {
    expect(isBlocking(review('approve', ['suggestion', 'critical']), blocking)).toBe(true);
  });

  it('is false for approve with only suggestions', () => {
    expect(isBlocking(review('approve', ['suggestion']), blocking)).toBe(false);
  });

  it('respects a custom blocking severity list', () => {
    expect(isBlocking(review('approve', ['important']), ['critical'])).toBe(false);
    expect(isBlocking(review('approve', ['suggestion']), ['suggestion'])).toBe(true);
  });
});
