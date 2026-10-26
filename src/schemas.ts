import { z } from 'zod';

export const RoleSchema = z.enum(['orchestrator', 'implementer', 'reviewer']);
export type Role = z.infer<typeof RoleSchema>;

export const AgentStateSchema = z.enum(['busy', 'idle', 'exited']);
export type AgentState = z.infer<typeof AgentStateSchema>;

export const AgentSchema = z.object({
  id: z.string().min(1),
  role: RoleSchema,
  runId: z.string().nullable(),
  cli: z.string().min(1),
  model: z.string().nullable(),
  paneId: z.string().nullable(),
  state: AgentStateSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  lastOutputAt: z.string().nullable(),
});
export type Agent = z.infer<typeof AgentSchema>;

export const MessageTypeSchema = z.enum([
  'task',
  'gate_result',
  'review_request',
  'review_result',
  'notice',
  'chat',
]);
export type MessageType = z.infer<typeof MessageTypeSchema>;

export const MessageSchema = z.object({
  id: z.number().int().positive(),
  from: RoleSchema,
  to: RoleSchema,
  /** Agent instance that sent the message, when known. */
  fromAgent: z.string().nullable().optional(),
  /** Agent instance the message is addressed to; null means addressed to the whole role. */
  toAgent: z.string().nullable().optional(),
  type: MessageTypeSchema,
  runId: z.string().nullable(),
  payload: z.unknown(),
  createdAt: z.iso.datetime(),
  ackedAt: z.iso.datetime().nullable(),
});
export type Message = z.infer<typeof MessageSchema>;

export const SeveritySchema = z.enum(['critical', 'important', 'suggestion']);
export type Severity = z.infer<typeof SeveritySchema>;

export const FindingSchema = z.object({
  severity: SeveritySchema,
  file: z.string().min(1),
  line: z.number().int().positive().optional(),
  summary: z.string().min(1).max(2000),
});
export type Finding = z.infer<typeof FindingSchema>;

export const ReviewSchema = z.object({
  verdict: z.enum(['approve', 'changes']),
  summary: z.string().min(1).max(5000),
  findings: z.array(FindingSchema).max(100).default([]),
});
export type Review = z.infer<typeof ReviewSchema>;

export const RunStateSchema = z.enum([
  'implementing',
  'gating',
  'reviewing',
  'approved',
  'pr_opened',
  'blocked',
]);
export type RunState = z.infer<typeof RunStateSchema>;

export const GateStepResultSchema = z.object({
  name: z.string(),
  command: z.string(),
  exitCode: z.number().int(),
  durationMs: z.number().nonnegative(),
  outputTail: z.string(),
});
export type GateStepResult = z.infer<typeof GateStepResultSchema>;

export const GateResultSchema = z.object({
  passed: z.boolean(),
  steps: z.array(GateStepResultSchema),
});
export type GateResult = z.infer<typeof GateResultSchema>;

export const HookEventSchema = z.object({
  role: RoleSchema,
  cli: z.enum(['claude', 'copilot']),
  state: z.enum(['idle', 'busy']),
  /** Free text, passed through from the CLI launcher; never validated against a model list. */
  model: z.string().min(1).optional(),
  sessionId: z.string().optional(),
  /** When the CLI last produced output; the bus uses the receive time when absent. */
  lastOutputAt: z.iso.datetime().optional(),
});
export type HookEvent = z.infer<typeof HookEventSchema>;
