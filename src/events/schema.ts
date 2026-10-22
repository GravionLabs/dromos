import { z } from 'zod';
import { HookEventSchema, RoleSchema } from '../schemas.js';

const hookData = HookEventSchema.meta({ id: 'HookEvent' });

/** Fields shared by every bus event. `source` is the role that emitted the event. */
const envelope = {
  id: z.number().int(),
  at: z.iso.datetime(),
  source: RoleSchema,
  agentId: z.string().nullable(),
  issue: z.number().int().nullable(),
  runId: z.string().nullable(),
};

export const HookIdleEventSchema = z
  .object({ ...envelope, type: z.literal('hook:idle'), data: hookData })
  .meta({ id: 'HookIdleEvent' });

export const HookBusyEventSchema = z
  .object({ ...envelope, type: z.literal('hook:busy'), data: hookData })
  .meta({ id: 'HookBusyEvent' });

export const BusEventSchema = z
  .discriminatedUnion('type', [HookIdleEventSchema, HookBusyEventSchema])
  .meta({ id: 'BusEvent' });
export type BusEvent = z.infer<typeof BusEventSchema>;

export const BUS_EVENT_TYPES = [
  'hook:idle',
  'hook:busy',
] as const satisfies readonly BusEvent['type'][];
