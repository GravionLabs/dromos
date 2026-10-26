import type { AttentionRecord, Db, EventRecord } from './db.js';
import type { BusEvent } from './events/schema.js';

/**
 * Stores an `attention` event and its open attention row in one transaction, so a failing row
 * rolls the event back too. The attention id equals the event id.
 */
export function recordAttention(
  db: Db,
  event: Extract<BusEvent, { type: 'attention' }>,
): { event: EventRecord; attention: AttentionRecord } {
  return db.transaction(() => {
    const row = db.insertEvent(event.source, event.type, event.data, {
      agentId: event.agentId,
      issue: event.issue,
      runId: event.runId,
    });
    return { event: row, attention: db.insertAttention(row) };
  });
}

/** Result of an answer or ack: the updated attention and its lifecycle event on success. */
export type AttentionTransitionResult =
  | { outcome: 'ok'; attention: AttentionRecord; event: EventRecord }
  | { outcome: 'not_found' | 'conflict' };

/**
 * Compare-and-set `open -> answered` and its `attention.answered` event in one transaction: a
 * failing event insert leaves the attention open. The caller publishes the event after commit.
 */
export function answerAttention(
  db: Db,
  id: number,
  text: string,
  by: string,
): AttentionTransitionResult {
  return db.transaction(() => {
    const outcome = db.answerAttention(id, text, by);
    return outcome === 'ok'
      ? withEvent(db, id, 'attention.answered', { id, text, by })
      : { outcome };
  });
}

/** Compare-and-set `answered -> acked` and its `attention.acked` event in one transaction. */
export function ackAttention(db: Db, id: number, by: string | null): AttentionTransitionResult {
  return db.transaction(() => {
    const outcome = db.ackAttention(id, by);
    return outcome === 'ok' ? withEvent(db, id, 'attention.acked', { id, by }) : { outcome };
  });
}

function withEvent(
  db: Db,
  id: number,
  type: 'attention.answered' | 'attention.acked',
  data: Record<string, unknown>,
): AttentionTransitionResult {
  const attention = db.getAttention(id) as AttentionRecord;
  const event = db.insertEvent('dromos', type, data, {
    issue: attention.issue,
    runId: attention.runId,
  });
  return { outcome: 'ok', attention, event };
}
