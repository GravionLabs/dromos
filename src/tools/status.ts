import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolContext } from '../context.js';
import type { Run } from '../db.js';
import { type GateResult, RoleSchema } from '../schemas.js';
import { errorResult, jsonResult } from './util.js';

/** Longest outputTail returned for a failed step; the end of the output is kept. */
const MAX_TAIL = 4000;

/** Keeps outputTail (bounded) only on failed steps (exitCode != 0); never mutates the input. */
export function slimGate(gate: GateResult | null): unknown {
  if (!gate) return null;
  return {
    passed: gate.passed,
    steps: gate.steps.map((s) => {
      const base = {
        name: s.name,
        command: s.command,
        exitCode: s.exitCode,
        durationMs: s.durationMs,
      };
      return s.exitCode === 0 ? base : { ...base, outputTail: s.outputTail.slice(-MAX_TAIL) };
    }),
  };
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function summary(r: Run) {
  return {
    id: r.id,
    issue: r.issueNumber,
    title: r.issueTitle,
    state: r.state,
    round: r.round,
    updatedAt: r.updatedAt,
    prUrl: r.prUrl,
  };
}

export function registerStatusTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'status',
    {
      description:
        'Any role. Without runId: list all runs, newest first. With runId: the full run ' +
        '(last gate, last review), unacked inbox counts per role and the last hook event per role.',
      inputSchema: {
        runId: z.string().min(1).optional().describe('Run id; omit to list all runs'),
      },
    },
    async ({ runId }) => {
      if (runId === undefined) return jsonResult(ctx.db.listRuns().map(summary));
      const run = ctx.db.getRun(runId);
      if (!run) return errorResult(`unknown run: ${runId}`);
      const hooks = ctx.db.lastHookEventPerRole().map((e) => {
        const d =
          typeof e.data === 'object' && e.data !== null ? (e.data as Record<string, unknown>) : {};
        return {
          role: e.role,
          cli: str(d.cli),
          model: str(d.model),
          state: e.kind.slice('hook:'.length),
          createdAt: e.createdAt,
        };
      });
      const counts = ctx.db.countUnackedByRole(runId);
      const unackedByRole = Object.fromEntries(RoleSchema.options.map((r) => [r, counts[r] ?? 0]));
      return jsonResult({
        id: run.id,
        repo: run.repo,
        repoPath: run.repoPath,
        issueNumber: run.issueNumber,
        issueTitle: run.issueTitle,
        baseBranch: run.baseBranch,
        branch: run.branch,
        worktreePath: run.worktreePath,
        state: run.state,
        round: run.round,
        lastGate: slimGate(run.lastGate),
        lastReview: run.lastReview,
        prUrl: run.prUrl,
        lastSummary: run.lastSummary,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        unackedByRole,
        lastHookEvents: hooks,
      });
    },
  );
}
