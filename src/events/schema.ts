import { z } from 'zod';
import { HookEventSchema } from '../schemas.js';

// Strict objects: unknown keys are rejected, matching `additionalProperties: false` in the exported
// JSON Schema and `deny_unknown_fields` in the generated Rust types.
const hookData = z.strictObject(HookEventSchema.shape).meta({ id: 'HookEvent' });

// Free text from external producers must not carry control characters (terminal escape sequences,
// ANSI colour codes, newlines): consumers render these values. The check is a refinement, so it is
// not part of the exported JSON Schema; the Rust `Event` deserialiser repeats it.
// `max` counts UTF-16 units here but code points in JSON Schema and Rust, so Zod is the stricter
// of the three for astral characters.
const noControlChars = (s: string) => !/\p{Cc}/u.test(s);
const text = (min: number, max: number) =>
  z.string().min(min).max(max).refine(noControlChars, 'control characters are not allowed');

/**
 * Fields shared by every bus event. `source` names the emitter: a role name for bus events, a free
 * identifier such as `apm-hub/subagent-stop` for external producers.
 *
 * `source` is a label, not an authenticated identity: the schema cannot stop a producer from
 * claiming a role name such as `orchestrator`. The ingest endpoint (#83) must authenticate the
 * caller and set or restrict `source` itself; consumers must not trust it for authorisation.
 */
const envelope = {
  /** Safe integer (±2^53-1). The generated Rust type is a wider i64; the bus is the producer. */
  id: z.number().int(),
  at: z.iso.datetime(),
  source: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-z][a-z0-9._/-]*$/),
  agentId: text(1, 128).nullable(),
  issue: z.number().int().nullable(),
  runId: text(1, 128).nullable(),
};

export const HookIdleEventSchema = z
  .strictObject({ ...envelope, type: z.literal('hook:idle'), data: hookData })
  .meta({ id: 'HookIdleEvent' });

export const HookBusyEventSchema = z
  .strictObject({ ...envelope, type: z.literal('hook:busy'), data: hookData })
  .meta({ id: 'HookBusyEvent' });

/** One ledger line of an orchestrator run. */
export const ProgressEventSchema = z
  .strictObject({
    ...envelope,
    type: z.literal('progress'),
    data: z.strictObject({ line: text(1, 1000), agent: text(1, 64) }).meta({ id: 'ProgressData' }),
  })
  .meta({ id: 'ProgressEvent' });

/** A run needs a human: gate, blocked, failed or a question. */
export const AttentionEventSchema = z
  .strictObject({
    ...envelope,
    type: z.literal('attention'),
    data: z
      .strictObject({
        kind: z.enum(['GATE', 'BLOCKED', 'FAILED', 'QUESTION']),
        summary: text(1, 2000),
        pr: z.number().int().nullable(),
      })
      .meta({ id: 'AttentionData' }),
  })
  .meta({ id: 'AttentionEvent' });

/** Context and cost sample of one agent. */
export const UsageEventSchema = z
  .strictObject({
    ...envelope,
    type: z.literal('usage'),
    data: z
      .strictObject({
        contextTokens: z.number().int().min(0),
        costUsd: z.number().min(0).nullable(),
        model: text(1, 128).nullable(),
      })
      .meta({ id: 'UsageData' }),
  })
  .meta({ id: 'UsageEvent' });

/** Queue runner lifecycle of one issue: one `started` and one `exited`. */
export const QueueItemEventSchema = z
  .strictObject({
    ...envelope,
    type: z.literal('queue.item'),
    data: z
      .strictObject({
        state: z.enum(['started', 'exited']),
        /** Queue runner exit codes 0..3 (#43, apm-hub#392); null while `started`. */
        exitCode: z.number().int().min(0).max(3).nullable(),
        durationMs: z.number().int().min(0).nullable(),
        mode: text(1, 64).nullable(),
      })
      // `started` carries no result yet; `exited` always carries an exit code. Not expressible in
      // the exported JSON Schema; the Rust `Event` deserialiser repeats it.
      .refine(
        (d) =>
          d.state === 'started'
            ? d.exitCode === null && d.durationMs === null
            : d.exitCode !== null,
        'started has no exitCode or durationMs; exited requires an exitCode',
      )
      .meta({ id: 'QueueItemData' }),
  })
  .meta({ id: 'QueueItemEvent' });

export const BusEventSchema = z
  .discriminatedUnion('type', [
    HookIdleEventSchema,
    HookBusyEventSchema,
    ProgressEventSchema,
    AttentionEventSchema,
    UsageEventSchema,
    QueueItemEventSchema,
  ])
  .meta({ id: 'BusEvent' });
export type BusEvent = z.infer<typeof BusEventSchema>;

export const BUS_EVENT_TYPES = [
  'hook:idle',
  'hook:busy',
  'progress',
  'attention',
  'usage',
  'queue.item',
] as const satisfies readonly BusEvent['type'][];
