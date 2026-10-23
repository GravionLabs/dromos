import type { BusEvents } from './bus-events.js';
import type { BusEvent, Db } from './db.js';

/** Single write path for events: store the row, then broadcast it (id = row id). */
export function recordEvent(
  db: Db,
  events: BusEvents,
  role: string,
  kind: string,
  data: unknown,
): BusEvent {
  const row = db.insertEvent(role, kind, data);
  events.publishEvent(row);
  return row;
}
