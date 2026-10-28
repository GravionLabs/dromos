/**
 * Run state machine of one PBI: `selected → implementing(round) → testing → reviewing → fixing(round)
 * → testing → pr_opened`, and any state → `blocked(reason)`. Pure: every transition returns the next
 * state plus the event to emit; the runner performs the I/O and feeds the outcome back in.
 */

export type RunState =
  | { kind: 'selected' }
  | { kind: 'implementing'; round: number }
  | { kind: 'testing'; round: number }
  | { kind: 'reviewing'; round: number }
  | { kind: 'fixing'; round: number }
  | { kind: 'pr_opened' }
  | { kind: 'blocked'; reason: string };

/** What happened; the runner reports it after each step. */
export type RunInput =
  | { type: 'start' }
  | { type: 'implemented' }
  | { type: 'tests_passed' }
  | { type: 'tests_failed'; summary: string }
  | { type: 'review_clean' }
  | { type: 'review_findings'; count: number }
  | { type: 'fixed' }
  | { type: 'abort'; reason: string };

/** The event a transition asks the runner to emit. */
export type RunEvent =
  | { type: 'run.started'; base?: string }
  | { type: 'implement.finished'; round: number }
  | { type: 'tests.passed'; round: number }
  | { type: 'tests.failed'; round: number; summary: string }
  | { type: 'review.clean'; round: number }
  | { type: 'review.findings'; round: number; count: number }
  | { type: 'fix.finished'; round: number }
  | { type: 'run.blocked'; reason: string };

export interface Transition {
  state: RunState;
  event: RunEvent;
}

export const INITIAL_STATE: RunState = { kind: 'selected' };

export function isTerminal(state: RunState): boolean {
  return state.kind === 'pr_opened' || state.kind === 'blocked';
}

function blocked(reason: string): Transition {
  return { state: { kind: 'blocked', reason }, event: { type: 'run.blocked', reason } };
}

/**
 * The next state for `input`. `maxFixRounds` is the number of fix rounds allowed after the first
 * review; findings that would need a further round block the run. An input that does not fit the state, or any input in a
 * terminal state, blocks (or, in a terminal state, is rejected) rather than being ignored.
 */
export function transition(state: RunState, input: RunInput, maxFixRounds: number): Transition {
  if (isTerminal(state)) {
    throw new Error(`run is already ${state.kind}; cannot apply ${input.type}`);
  }
  if (input.type === 'abort') return blocked(input.reason);

  switch (state.kind) {
    case 'selected':
      if (input.type === 'start') {
        return {
          state: { kind: 'implementing', round: 0 },
          event: { type: 'run.started' },
        };
      }
      break;
    case 'implementing':
      if (input.type === 'implemented') {
        return {
          state: { kind: 'testing', round: state.round },
          event: { type: 'implement.finished', round: state.round },
        };
      }
      break;
    case 'testing':
      if (input.type === 'tests_passed') {
        // Round 0 is the first implementation and always gets reviewed; after a fix the run is reviewed
        // again only while fix rounds remain, otherwise the fixed result goes to the pull request.
        const next: RunState =
          state.round === 0 || state.round < maxFixRounds
            ? { kind: 'reviewing', round: state.round }
            : { kind: 'pr_opened' };
        return { state: next, event: { type: 'tests.passed', round: state.round } };
      }
      if (input.type === 'tests_failed') {
        return blocked(`tests failed in round ${state.round}: ${input.summary}`);
      }
      break;
    case 'reviewing':
      if (input.type === 'review_clean') {
        return {
          state: { kind: 'pr_opened' },
          event: { type: 'review.clean', round: state.round },
        };
      }
      if (input.type === 'review_findings') {
        if (state.round >= maxFixRounds) {
          return blocked(`${input.count} review findings remain after ${state.round} fix round(s)`);
        }
        return {
          state: { kind: 'fixing', round: state.round + 1 },
          event: { type: 'review.findings', round: state.round, count: input.count },
        };
      }
      break;
    case 'fixing':
      if (input.type === 'fixed') {
        return {
          state: { kind: 'testing', round: state.round },
          event: { type: 'fix.finished', round: state.round },
        };
      }
      break;
  }
  return blocked(`unexpected ${input.type} in state ${state.kind}`);
}
