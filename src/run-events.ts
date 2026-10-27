import { z } from 'zod';
import { recordAttention } from './attention.js';
import type { BusEvents } from './bus-events.js';
import type { Db, EventRecord, Run } from './db.js';
import { EventValidationError } from './event-store.js';
import { type ATTEMPT_OUTCOMES, BusEventSchema, type EVIDENCE_TIERS } from './events/schema.js';

/** Role and `source` of every server-owned run event. */
const SOURCE = 'dromos';
const PAGE = 500;

type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number];
type Evidence = (typeof EVIDENCE_TIERS)[number];
type AttemptStarted = { n: number; cause: string; startedAt: string };

/**
 * How the current attempt ended. When the transition retries (next state `implementing`), the
 * outcome is also the cause of the new attempt, so only `gate_failed` and `sent_back` retry.
 */
export interface AttemptSettlement {
  outcome: AttemptOutcome;
  evidence: Evidence;
}

/** State and round of a run at one point of its life. */
export type RunPosition = Pick<Run, 'state' | 'round'>;

/** The run fields the events carry in their envelope. */
export type RunRef = Pick<Run, 'id' | 'issueNumber'>;

/** Latest `attempt.started` of the run, or undefined when the run has none (pre-existing run). */
function latestAttempt(db: Db, run: RunRef): AttemptStarted | undefined {
  let latest: AttemptStarted | undefined;
  let after: number | undefined;
  for (;;) {
    const page = db.queryEvents({
      issue: run.issueNumber,
      types: ['attempt.started'],
      sources: [SOURCE],
      after,
      limit: PAGE,
    });
    for (const event of page.events) {
      if (event.runId === run.id) latest = event.data as AttemptStarted;
    }
    if (page.next === null) return latest;
    after = page.next;
  }
}

/**
 * Validates one server-owned run event against BusEvent and inserts it; an invalid one throws
 * EventValidationError. Call it inside the transaction that changes the run row.
 */
export function recordRunEvent(
  db: Db,
  run: RunRef,
  type: string,
  data: unknown,
  at = new Date().toISOString(),
): EventRecord {
  const checked = BusEventSchema.safeParse({
    id: 0,
    type,
    at,
    source: SOURCE,
    agentId: null,
    issue: run.issueNumber,
    runId: run.id,
    data,
  });
  if (!checked.success) throw new EventValidationError(z.prettifyError(checked.error));
  return db.insertEvent(SOURCE, checked.data.type, checked.data.data, {
    agentId: null,
    issue: run.issueNumber,
    runId: run.id,
  });
}

/**
 * Stores the events of one run transition: always `run.state`; `attempt.started` (n = 1, cause
 * `initial`) when the run is created (`prev` null); `attempt.settled` for the open attempt when
 * `settle` is given, followed by a new `attempt.started` when the run goes back to
 * `implementing`. Every event is validated against BusEvent before it is inserted; an invalid one
 * throws EventValidationError. Call it inside the `db.transaction` that changes the run row so
 * both commit or roll back together, and publish the returned rows with `publishRows` only after
 * the transaction committed. Order within one transition: `run.state` first, then
 * `attempt.settled`, then the next `attempt.started` (ids ascend in that order). A run without an
 * `attempt.started` (created before attempts were recorded) emits no `attempt.settled`; its next
 * attempt is numbered after its round.
 */
export function recordRunTransition(
  db: Db,
  run: RunRef,
  prev: RunPosition | null,
  next: RunPosition,
  settle?: AttemptSettlement,
): EventRecord[] {
  const at = new Date().toISOString();
  const rows: EventRecord[] = [];
  const insert = (type: string, data: unknown) =>
    rows.push(recordRunEvent(db, run, type, data, at));

  insert('run.state', { state: next.state, round: next.round, previous: prev?.state ?? null });
  if (prev === null) {
    insert('attempt.started', { n: 1, cause: 'initial', startedAt: at });
    return rows;
  }
  if (settle === undefined) return rows;
  const open = latestAttempt(db, run);
  if (open) {
    insert('attempt.settled', {
      n: open.n,
      cause: open.cause,
      startedAt: open.startedAt,
      endedAt: at,
      outcome: settle.outcome,
      evidence: settle.evidence,
    });
  }
  if (next.state === 'implementing') {
    // A run created before attempts were recorded has none; its next attempt follows its round.
    insert('attempt.started', {
      n: open ? open.n + 1 : next.round,
      cause: settle.outcome,
      startedAt: at,
    });
  }
  return rows;
}

/**
 * Stores the BLOCKED attention (event + open attention row) of a run that hit the round limit.
 * Call it inside the transaction that moves the run to `blocked`; a run blocks once, so this
 * stores one attention per run. Returns the event row to publish after commit.
 */
export function recordBlockedAttention(
  db: Db,
  run: Pick<Run, 'id' | 'issueNumber' | 'worktreePath' | 'round'>,
  origin: 'gate' | 'review',
): EventRecord {
  const checked = BusEventSchema.safeParse({
    id: 0,
    type: 'attention',
    at: new Date().toISOString(),
    source: SOURCE,
    agentId: null,
    issue: run.issueNumber,
    runId: run.id,
    data: {
      kind: 'BLOCKED',
      summary: `round limit reached after ${run.round} rounds (${origin})`,
      pr: null,
      checkout: run.worktreePath,
    },
  });
  if (!checked.success) throw new EventValidationError(z.prettifyError(checked.error));
  if (checked.data.type !== 'attention') throw new EventValidationError('not an attention event');
  return recordAttention(db, checked.data).event;
}

/** Broadcasts committed event rows to stream subscribers, in order. */
export function publishRows(events: BusEvents, rows: readonly EventRecord[]): void {
  for (const row of rows) events.publishEvent(row);
}
