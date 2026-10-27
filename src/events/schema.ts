import { z } from 'zod';
import { HookEventSchema, ReviewSchema, RunStateSchema } from '../schemas.js';

// Free text from external producers must not carry characters that break or spoof rendering:
// control characters (`Cc`, incl. ESC, DEL, C1), bidi controls, zero-width characters, line and
// paragraph separators and the BOM. The set is explicit (not `\p{Cf}`) so it cannot drift with the
// Unicode version and equals `is_forbidden_char` in the Rust crate; `schema/parity.json` checks
// both. The check is a refinement, so it is not part of the exported JSON Schema.
// Zod 4 `min`/`max` count code points, like the JSON Schema `maxLength` and the Rust types.
export const FORBIDDEN_CHARS =
  /[\p{Cc}\u061C\u200B-\u200F\u2028-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/u;
/** Version of the bus event schema carried by `dromos run export`; bump on a breaking change. */
export const EVENTS_SCHEMA_VERSION = 1;

const noForbiddenChars = (s: string) => !FORBIDDEN_CHARS.test(s);
const FORBIDDEN_MSG = 'control or invisible formatting characters are not allowed';
const text = (min: number, max: number) =>
  z.string().min(min).max(max).refine(noForbiddenChars, FORBIDDEN_MSG);

/**
 * How an outcome was established, strongest first: `verified` (the bus ran the check itself),
 * `reported` (a tool reported a result), `heuristic` (inferred) and `asserted` (an agent's claim).
 * An optional `evidence` field that is absent means `asserted`.
 */
export const EVIDENCE_TIERS = ['verified', 'reported', 'heuristic', 'asserted'] as const;
const evidence = z.enum(EVIDENCE_TIERS);

// Strict objects: unknown keys are rejected, matching `additionalProperties: false` in the exported
// JSON Schema and `deny_unknown_fields` in the generated Rust types.
const hookData = z
  .strictObject({
    ...HookEventSchema.shape,
    model: z.string().min(1).refine(noForbiddenChars, FORBIDDEN_MSG).optional(),
    sessionId: z.string().refine(noForbiddenChars, FORBIDDEN_MSG).optional(),
    /** Time of the agent's last terminal output, for liveness. */
    lastOutputAt: z.iso.datetime().optional(),
    evidence: evidence.optional(),
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

/** Entry cap of `progress.data.fields`; the Rust `check_constraints` enforces the same number. */
const MAX_PROGRESS_FIELDS = 32;

/** Classification of a ledger line; optional on `progress` events. */
export const PROGRESS_KINDS = [
  'phase',
  'task',
  'wave',
  'fix-round',
  'ruling',
  'gate',
  'loop',
  'complete',
  'subagent',
  'other',
] as const;

/** One ledger line of an orchestrator run. */
export const ProgressEventSchema = z
  .strictObject({
    ...envelope,
    type: z.literal('progress'),
    data: z
      .strictObject({
        line: text(1, 1000),
        agent: text(1, 64),
        kind: z.enum(PROGRESS_KINDS).optional(),
        fields: z
          .record(text(1, 64), z.union([text(0, 1000), z.number(), z.null()]))
          .refine((o) => Object.keys(o).length <= MAX_PROGRESS_FIELDS, 'at most 32 entries')
          .meta({ maxProperties: MAX_PROGRESS_FIELDS })
          .optional(),
        evidence: evidence.optional(),
      })
      .meta({ id: 'ProgressData' }),
  })
  .meta({ id: 'ProgressEvent' });

/** Entry cap of `attention.data.options`; the Rust `check_constraints` enforces the same number. */
const MAX_ATTENTION_OPTIONS = 16;

/** A run needs a human: gate, blocked, failed or a question. */
export const AttentionEventSchema = z
  .strictObject({
    ...envelope,
    type: z.literal('attention'),
    data: z
      .strictObject({
        /** Free-form: `GATE`, `BLOCKED`, `FAILED`, `QUESTION`, `FEATURE_DONE`, ... */
        kind: text(1, 64),
        summary: text(1, 2000),
        pr: z.number().int().nullable(),
        question: text(1, 2000).optional(),
        options: z
          .array(text(1, 200))
          .max(MAX_ATTENTION_OPTIONS)
          .meta({ maxItems: MAX_ATTENTION_OPTIONS })
          .optional(),
        checkout: text(1, 4096).optional(),
      })
      .meta({ id: 'AttentionData' }),
  })
  .meta({ id: 'AttentionEvent' });

/** Server-owned: a human answered an attention. Envelope `issue`/`runId` are the attention's. */
export const AttentionAnsweredEventSchema = z
  .strictObject({
    ...envelope,
    type: z.literal('attention.answered'),
    data: z
      .strictObject({
        id: z.number().int().min(1),
        text: text(1, 4000),
        by: text(1, 128),
      })
      .meta({ id: 'AttentionAnsweredData' }),
  })
  .meta({ id: 'AttentionAnsweredEvent' });

/** Server-owned: an attention was acknowledged. Envelope `issue`/`runId` are the attention's. */
export const AttentionAckedEventSchema = z
  .strictObject({
    ...envelope,
    type: z.literal('attention.acked'),
    data: z
      .strictObject({
        id: z.number().int().min(1),
        by: text(1, 128).nullable(),
      })
      .meta({ id: 'AttentionAckedData' }),
  })
  .meta({ id: 'AttentionAckedEvent' });

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
        /** Time of the agent's last terminal output, for liveness. */
        lastOutputAt: z.iso.datetime().optional(),
      })
      .meta({ id: 'AgentStateData' }),
  })
  .meta({ id: 'AgentStateEvent' });

/**
 * One subagent run of a client session (Claude Code, Copilot CLI), reported by an external hook.
 * Not to be confused with `agent.registered` / `agent.state`, which describe bus agent instances:
 * `agent.run` is a client-side subagent, never a bus agent. The envelope `agentId` stays the bus
 * identity of the reporting pane; `runAgentId` is the client's subagent id.
 */
export const AgentRunEventSchema = z
  .strictObject({
    ...envelope,
    type: z.literal('agent.run'),
    data: z
      .strictObject({
        state: z.enum(['started', 'stopped']),
        runAgentId: text(1, 64),
        parentAgentId: text(1, 64).nullable(),
        toolUseId: text(1, 64).nullable(),
        agentType: text(1, 64),
        description: text(0, 200).nullable(),
        depth: z.number().int().min(1).max(8),
        model: text(1, 128).nullable(),
        durationMs: z.number().int().min(0).nullable(),
        summary: text(0, 120).nullable(),
      })
      .meta({ id: 'AgentRunData' }),
  })
  .meta({ id: 'AgentRunEvent' });

/** Workflow round of a run, 1-based. */
const round = z.number().int().min(1);

/** Server-owned: a run changed its workflow state. `previous` is null for the first state. */
export const RunStateEventSchema = z
  .strictObject({
    ...envelope,
    type: z.literal('run.state'),
    data: z
      .strictObject({
        state: RunStateSchema,
        round,
        previous: RunStateSchema.nullable(),
      })
      .meta({ id: 'RunStateData' }),
  })
  .meta({ id: 'RunStateEvent' });

/** Step cap of `gate.result.data.steps`; the Rust `check_constraints` enforces the same number. */
export const MAX_GATE_STEPS = 32;

/** Server-owned: result of one gate run. Step output stays out of events (free text). */
export const GateResultEventSchema = z
  .strictObject({
    ...envelope,
    type: z.literal('gate.result'),
    data: z
      .strictObject({
        passed: z.boolean(),
        round,
        evidence,
        durationMs: z.number().int().min(0),
        failedStep: text(1, 128).nullable(),
        steps: z
          .array(
            z
              .strictObject({
                name: text(1, 128),
                exitCode: z.number().int(),
                durationMs: z.number().int().min(0),
              })
              .meta({ id: 'GateResultStep' }),
          )
          .max(MAX_GATE_STEPS)
          .meta({ maxItems: MAX_GATE_STEPS }),
      })
      .meta({ id: 'GateResultData' }),
  })
  .meta({ id: 'GateResultEvent' });

/** Server-owned: verdict of one review round. Counts only; finding text stays out of events. */
export const ReviewResultEventSchema = z
  .strictObject({
    ...envelope,
    type: z.literal('review.result'),
    data: z
      .strictObject({
        verdict: ReviewSchema.shape.verdict,
        round,
        blockingFindings: z.number().int().min(0),
        findings: z.number().int().min(0),
        evidence,
      })
      .meta({ id: 'ReviewResultData' }),
  })
  .meta({ id: 'ReviewResultEvent' });

/** Why an attempt started: the first one, after a failed gate or after a review sent it back. */
export const ATTEMPT_CAUSES = ['initial', 'gate_failed', 'sent_back'] as const;
/** How an attempt ended. */
export const ATTEMPT_OUTCOMES = ['gate_failed', 'sent_back', 'approved', 'blocked'] as const;
/** Attempt number, 1-based. */
const attemptN = z.number().int().min(1);

/** Server-owned: an implementation attempt of a run started. */
export const AttemptStartedEventSchema = z
  .strictObject({
    ...envelope,
    type: z.literal('attempt.started'),
    data: z
      .strictObject({
        n: attemptN,
        cause: z.enum(ATTEMPT_CAUSES),
        startedAt: z.iso.datetime(),
      })
      .meta({ id: 'AttemptStartedData' }),
  })
  .meta({ id: 'AttemptStartedEvent' });

/** Server-owned: an implementation attempt of a run ended. */
export const AttemptSettledEventSchema = z
  .strictObject({
    ...envelope,
    type: z.literal('attempt.settled'),
    data: z
      .strictObject({
        n: attemptN,
        cause: z.enum(ATTEMPT_CAUSES),
        startedAt: z.iso.datetime(),
        endedAt: z.iso.datetime(),
        outcome: z.enum(ATTEMPT_OUTCOMES),
        evidence,
      })
      .meta({ id: 'AttemptSettledData' }),
  })
  .meta({ id: 'AttemptSettledEvent' });

/** Token usage and cost of one phase; `costUsd` is null where the harness reports none. */
export const PhaseUsageSchema = z
  .strictObject({
    inputTokens: z.number().int().min(0),
    outputTokens: z.number().int().min(0),
    costUsd: z.number().min(0).nullable(),
  })
  .meta({ id: 'PhaseUsage' });

const phaseBase = {
  phase: text(1, 64),
  harness: z
    .strictObject({
      name: text(1, 64),
      version: text(1, 64).nullable(),
      sdk: text(1, 64).nullable(),
    })
    .meta({ id: 'PhaseHarness' }),
  model: text(1, 128),
};
const phaseEnd = {
  ...phaseBase,
  durationMs: z.number().int().min(0),
  /** Null where the harness reports no usage; never estimated. */
  usage: PhaseUsageSchema.nullable(),
};

/** Runner-owned: a phase (planner, implementer, reviewer, retro) of a run started. */
export const PhaseStartedEventSchema = z
  .strictObject({
    ...envelope,
    type: z.literal('phase.started'),
    data: z.strictObject(phaseBase).meta({ id: 'PhaseStartedData' }),
  })
  .meta({ id: 'PhaseStartedEvent' });

/** Runner-owned: a phase ended with a result that matched its schema. */
export const PhaseFinishedEventSchema = z
  .strictObject({
    ...envelope,
    type: z.literal('phase.finished'),
    data: z
      .strictObject({
        ...phaseEnd,
        /** Planner phase only: questions still unanswered after prompt, flags and defaults. */
        unansweredQuestions: z.number().int().min(0).optional(),
      })
      .meta({ id: 'PhaseFinishedData' }),
  })
  .meta({ id: 'PhaseFinishedEvent' });

/** Runner-owned: a phase ended without a valid result (error, timeout, schema mismatch). */
export const PhaseFailedEventSchema = z
  .strictObject({
    ...envelope,
    type: z.literal('phase.failed'),
    data: z.strictObject(phaseEnd).meta({ id: 'PhaseFailedData' }),
  })
  .meta({ id: 'PhaseFailedEvent' });

export const BusEventSchema = z
  .discriminatedUnion('type', [
    HookIdleEventSchema,
    HookBusyEventSchema,
    ProgressEventSchema,
    AttentionEventSchema,
    AttentionAnsweredEventSchema,
    AttentionAckedEventSchema,
    UsageEventSchema,
    QueueItemEventSchema,
    AgentRegisteredEventSchema,
    AgentStateEventSchema,
    AgentRunEventSchema,
    RunStateEventSchema,
    GateResultEventSchema,
    ReviewResultEventSchema,
    AttemptStartedEventSchema,
    AttemptSettledEventSchema,
    PhaseStartedEventSchema,
    PhaseFinishedEventSchema,
    PhaseFailedEventSchema,
  ])
  .meta({ id: 'BusEvent' });
export type BusEvent = z.infer<typeof BusEventSchema>;

export const BUS_EVENT_TYPES = [
  'hook:idle',
  'hook:busy',
  'progress',
  'attention',
  'attention.answered',
  'attention.acked',
  'usage',
  'queue.item',
  'agent.registered',
  'agent.state',
  'agent.run',
  'run.state',
  'gate.result',
  'review.result',
  'attempt.started',
  'attempt.settled',
  'phase.started',
  'phase.finished',
  'phase.failed',
] as const satisfies readonly BusEvent['type'][];

/**
 * Event types an external producer may post to `POST /ingest`. Server-owned types (`attention.*`,
 * `run.state`, `gate.result`, `review.result`, `attempt.*`, `phase.*`) stay out. Extend this list to open a new type
 * to ingest; every entry must be a `BusEvent['type']`.
 */
export const INGEST_TYPES = [
  'progress',
  'attention',
  'usage',
  'queue.item',
  'agent.state',
  'agent.run',
] as const satisfies readonly BusEvent['type'][];
export type IngestType = (typeof INGEST_TYPES)[number];

export function isIngestType(type: unknown): type is IngestType {
  return typeof type === 'string' && (INGEST_TYPES as readonly string[]).includes(type);
}
