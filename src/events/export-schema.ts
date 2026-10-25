import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { BusEventSchema } from './schema.js';

export const EVENTS_SCHEMA_PATH = fileURLToPath(
  new URL('../../schema/events.schema.json', import.meta.url),
);

/** Draft-7 because the Rust generator (typify) targets draft-07 semantics. */
export function buildEventsSchema(): Record<string, unknown> {
  return z.toJSONSchema(BusEventSchema, { target: 'draft-7', io: 'output' });
}

export function serializeEventsSchema(): string {
  return `${JSON.stringify(buildEventsSchema(), null, 2)}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(EVENTS_SCHEMA_PATH, serializeEventsSchema());
}
