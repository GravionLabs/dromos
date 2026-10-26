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
