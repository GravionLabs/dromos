import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Db } from './db.js';
import { AgentStateSchema, RoleSchema, RunStateSchema } from './schemas.js';

/** Bumped on any incompatible change to the `GET /state` body. */
export const STATE_SNAPSHOT_VERSION = 1;
/** Most open attentions in one snapshot. */
export const MAX_OPEN_ATTENTIONS = 1000;

export const StateSnapshotSchema = z.object({
  version: z.literal(STATE_SNAPSHOT_VERSION),
  at: z.iso.datetime(),
  agents: z.array(
    z.object({
      id: z.string(),
      role: RoleSchema,
      client: z.string(),
      model: z.string().nullable(),
      state: AgentStateSchema,
      /** When the agent entered its current state. */
      since: z.string(),
    }),
  ),
  runs: z.array(
    z.object({
      id: z.string(),
      issue: z.number().int(),
      phase: RunStateSchema,
      gateRounds: z.number().int(),
      lastGate: z.object({ passed: z.boolean(), failedSteps: z.array(z.string()) }).nullable(),
      worktree: z.string(),
      pr: z.string().nullable(),
    }),
  ),
  attentions: z.array(
    z.object({
      id: z.number().int(),
      source: z.string(),
      agentId: z.string().nullable(),
      issue: z.number().int().nullable(),
      runId: z.string().nullable(),
      kind: z.string(),
      summary: z.string(),
      createdAt: z.string(),
    }),
  ),
});
export type StateSnapshot = z.infer<typeof StateSnapshotSchema>;

/** One snapshot of registered agents, active runs (all but `pr_opened`) and open attentions. */
export function buildStateSnapshot(db: Db, now: Date = new Date()): StateSnapshot {
  return {
    version: STATE_SNAPSHOT_VERSION,
    at: now.toISOString(),
    agents: db.listAgents().map((a) => ({
      id: a.id,
      role: a.role,
      client: a.cli,
      model: a.model,
      state: a.state,
      since: a.updatedAt,
    })),
    runs: db
      .listRuns()
      .filter((r) => r.state !== 'pr_opened')
      .map((r) => ({
        id: r.id,
        issue: r.issueNumber,
        phase: r.state,
        gateRounds: r.round,
        lastGate: r.lastGate
          ? {
              passed: r.lastGate.passed,
              failedSteps: r.lastGate.steps.filter((s) => s.exitCode !== 0).map((s) => s.name),
            }
          : null,
        worktree: r.worktreePath,
        pr: r.prUrl,
      })),
    attentions: db.listAttention({ state: 'open', limit: MAX_OPEN_ATTENTIONS }).map((a) => ({
      id: a.id,
      source: a.source,
      agentId: a.agentId,
      issue: a.issue,
      runId: a.runId,
      kind: a.kind,
      summary: a.summary,
      createdAt: a.createdAt,
    })),
  };
}

export const STATE_SCHEMA_PATH = fileURLToPath(
  new URL('../schema/state.schema.json', import.meta.url),
);

export function serializeStateSchema(): string {
  const schema = z.toJSONSchema(StateSnapshotSchema, { target: 'draft-7', io: 'output' });
  return `${JSON.stringify(schema, null, 2)}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(STATE_SCHEMA_PATH, serializeStateSchema());
}
