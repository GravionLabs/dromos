import { z } from 'zod';
import { HookEventSchema, RoleSchema } from '../schemas.js';

// Strict objects: unknown keys are rejected, matching `additionalProperties: false` in the exported
// JSON Schema and `deny_unknown_fields` in the generated Rust types.
const hookData = z.strictObject(HookEventSchema.shape).meta({ id: 'HookEvent' });

/** Fields shared by every bus event. `source` is the role that emitted the event. */
const envelope = {
  /** Safe integer (±2^53-1). The generated Rust type is a wider i64; the bus is the producer. */
  id: z.number().int(),
  at: z.iso.datetime(),
  source: RoleSchema,
  agentId: z.string().nullable(),
  issue: z.number().int().nullable(),
  runId: z.string().nullable(),
};

export const HookIdleEventSchema = z
  .strictObject({ ...envelope, type: z.literal('hook:idle'), data: hookData })
  .meta({ id: 'HookIdleEvent' });

export const HookBusyEventSchema = z
  .strictObject({ ...envelope, type: z.literal('hook:busy'), data: hookData })
  .meta({ id: 'HookBusyEvent' });

export const BusEventSchema = z
  .discriminatedUnion('type', [HookIdleEventSchema, HookBusyEventSchema])
  .meta({ id: 'BusEvent' });
export type BusEvent = z.infer<typeof BusEventSchema>;

export const BUS_EVENT_TYPES = [
  'hook:idle',
  'hook:busy',
] as const satisfies readonly BusEvent['type'][];
