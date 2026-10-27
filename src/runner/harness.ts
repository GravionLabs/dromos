import { z } from 'zod';
import type { PhaseUsageSchema } from '../events/schema.js';

export const HarnessNameSchema = z.enum(['claude', 'copilot']);
export type HarnessName = z.infer<typeof HarnessNameSchema>;

/** Token usage and cost of one phase; `null` on the result where the harness reports none. */
export type Usage = z.infer<typeof PhaseUsageSchema>;

/** Verdict of the allowlist for one tool call. */
export type Decision = { allow: true } | { allow: false; reason: string };

/**
 * One step the harness observed inside a phase (tool call, denied permission, message). The runner
 * wraps the phase in `phase.*` bus events itself; these are the trace in between.
 */
export const RunEventSchema = z.strictObject({
  at: z.iso.datetime(),
  kind: z.enum(['tool', 'permission_denied', 'message']),
  summary: z.string().min(1).max(500),
});
export type RunEvent = z.infer<typeof RunEventSchema>;

export interface PhaseInput {
  /** Phase prompt from apm-hub, with issue and plan paths filled in. */
  prompt: string;
  /** The worktree the phase runs in. */
  cwd: string;
  /** Per phase and per harness, from the runner config. */
  model: string;
  /** Skill directories to expose. */
  skills: string[];
  /** One allowlist plus the git guardrails, in TypeScript, for both harnesses. */
  allow: (tool: string, input: unknown) => Decision;
  /** The phase's output contract; `result` is validated against it. */
  schema: z.ZodType;
  timeoutMs: number;
}

export interface PhaseOutput {
  /** Parsed with `PhaseInput.schema`. */
  result: unknown;
  events: RunEvent[];
  /** `null` when the harness reports no usage; never estimated. */
  usage: Usage | null;
}

export interface Harness {
  runPhase(input: PhaseInput): Promise<PhaseOutput>;
}
