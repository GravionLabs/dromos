import type { Review, RunState, Severity } from './schemas.js';

export type RunEvent =
  | { type: 'implementation_submitted' }
  | { type: 'gate_passed' }
  | { type: 'gate_failed' }
  | { type: 'review_approved' }
  | { type: 'review_changes' }
  | { type: 'pr_opened' };

export type RunPosition = { state: RunState; round: number };

export class InvalidTransitionError extends Error {
  constructor(
    readonly state: RunState,
    readonly event: RunEvent['type'],
  ) {
    super(`Invalid transition: event '${event}' is not allowed in state '${state}'`);
    this.name = 'InvalidTransitionError';
  }
}

function retry(run: RunPosition, maxRounds: number): RunPosition {
  if (!Number.isInteger(maxRounds) || maxRounds < 1) {
    throw new RangeError(`maxRounds must be a positive integer, got ${maxRounds}`);
  }
  const round = run.round + 1;
  return { state: round > maxRounds ? 'blocked' : 'implementing', round };
}

export function transition(run: RunPosition, event: RunEvent, maxRounds: number): RunPosition {
  const { state, round } = run;
  switch (state) {
    case 'implementing':
      if (event.type === 'implementation_submitted') return { state: 'gating', round };
      break;
    case 'gating':
      if (event.type === 'gate_passed') return { state: 'reviewing', round };
      if (event.type === 'gate_failed') return retry(run, maxRounds);
      break;
    case 'reviewing':
      if (event.type === 'review_approved') return { state: 'approved', round };
      if (event.type === 'review_changes') return retry(run, maxRounds);
      break;
    case 'approved':
      if (event.type === 'pr_opened') return { state: 'pr_opened', round };
      break;
    default:
      break;
  }
  throw new InvalidTransitionError(state, event.type);
}

export function isBlocking(review: Review, blockingSeverities: Severity[]): boolean {
  return (
    review.verdict === 'changes' ||
    review.findings.some((finding) => blockingSeverities.includes(finding.severity))
  );
}
