import { z } from 'zod';
import { HookEventSchema } from '../schemas.js';

// Free text from external producers must not carry characters that break or spoof rendering:
// control characters (`Cc`, incl. ESC, DEL, C1), bidi controls, zero-width characters, line and
// paragraph separators and the BOM. The set is explicit (not `\p{Cf}`) so it cannot drift with the
// Unicode version and equals `is_forbidden_char` in the Rust crate; `schema/parity.json` checks
// both. The check is a refinement, so it is not part of the exported JSON Schema.
// Zod 4 `min`/`max` count code points, like the JSON Schema `maxLength` and the Rust types.
const FORBIDDEN_CHARS = /[\p{Cc}\u061C\u200B-\u200F\u2028-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/u;
const noForbiddenChars = (s: string) => !FORBIDDEN_CHARS.test(s);
const FORBIDDEN_MSG = 'control or invisible formatting characters are not allowed';
const text = (min: number, max: number) =>
  z.string().min(min).max(max).refine(noForbiddenChars, FORBIDDEN_MSG);

// Strict objects: unknown keys are rejected, matching `additionalProperties: false` in the exported
// JSON Schema and `deny_unknown_fields` in the generated Rust types.
const hookData = z
  .strictObject({
    ...HookEventSchema.shape,
    model: z.string().min(1).refine(noForbiddenChars, FORBIDDEN_MSG).optional(),
    sessionId: z.string().refine(noForbiddenChars, FORBIDDEN_MSG).optional(),
  })
  .meta({ id: 'HookEvent' });

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

/** An agent instance registered with the bus for the first time. */
export const AgentRegisteredEventSchema = z
  .strictObject({
    ...envelope,
    type: z.literal('agent.registered'),
    data: z
      .strictObject({
        role: text(1, 64),
        cli: text(1, 64),
        model: text(1, 128).nullable(),
      })
      .meta({ id: 'AgentRegisteredData' }),
  })
  .meta({ id: 'AgentRegisteredEvent' });

/** An agent instance changed its lifecycle state. */
export const AgentStateEventSchema = z
  .strictObject({
    ...envelope,
    type: z.literal('agent.state'),
    data: z
      .strictObject({
        state: z.enum(['busy', 'idle', 'exited']),
      })
      .meta({ id: 'AgentStateData' }),
  })
  .meta({ id: 'AgentStateEvent' });

export const BusEventSchema = z
  .discriminatedUnion('type', [
    HookIdleEventSchema,
    HookBusyEventSchema,
    ProgressEventSchema,
    AttentionEventSchema,
    UsageEventSchema,
    QueueItemEventSchema,
    AgentRegisteredEventSchema,
    AgentStateEventSchema,
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
  'agent.registered',
  'agent.state',
] as const satisfies readonly BusEvent['type'][];
