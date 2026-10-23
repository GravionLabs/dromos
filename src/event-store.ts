import type { BusEvents } from './bus-events.js';
import type { BusEvent, Db, EventContext } from './db.js';

/** Single write path for events: store the row, then broadcast it (id = row id). */
export function recordEvent(
  db: Db,
  events: BusEvents,
  role: string,
  kind: string,
  data: unknown,
  context?: EventContext,
): BusEvent {
  const row = db.insertEvent(role, kind, data, context);
  events.publishEvent(row);
  return row;
}
