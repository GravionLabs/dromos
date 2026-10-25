import { z } from 'zod';
import type { BusEvents } from './bus-events.js';
import type { Db, EventRecord } from './db.js';
import { BusEventSchema } from './events/schema.js';

/** Thrown by recordEvent when the event does not match the BusEvent schema; nothing was stored. */
export class EventValidationError extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = 'EventValidationError';
  }
}

/**
 * Single write path for events: validate against BusEvent, store the row, then broadcast it
 * (id = row id). `role` is the stored row role; the row keeps `kind = type`, `data = event.data`
 * and the envelope agentId/issue/runId. The envelope `id` is ignored (the row id is assigned on
 * insert). An invalid event is neither stored nor broadcast.
 */
export function recordEvent(db: Db, events: BusEvents, role: string, event: unknown): EventRecord {
  const checked = BusEventSchema.safeParse(event);
  if (!checked.success) {
    throw new EventValidationError(z.prettifyError(checked.error));
  }
  const { type, data, agentId, issue, runId } = checked.data;
  const row = db.insertEvent(role, type, data, { agentId, issue, runId });
  events.publishEvent(row);
  return row;
}
