import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolContext } from '../context.js';
import type { Run } from '../db.js';
import type { GateResult } from '../schemas.js';
import { errorResult, jsonResult } from './util.js';

/** Keeps outputTail only on failed steps (exitCode != 0). */
function slimGate(gate: GateResult | null): GateResult | null {
  if (!gate) return null;
  return {
    ...gate,
    steps: gate.steps.map((s) => {
      if (s.exitCode !== 0) return s;
      const { outputTail: _omit, ...rest } = s;
      return rest as typeof s;
    }),
  };
}

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
        const d = (e.data ?? {}) as { cli?: string; model?: string };
        return {
          role: e.role,
          cli: d.cli ?? null,
          model: d.model ?? null,
          state: e.kind.slice('hook:'.length),
          createdAt: e.createdAt,
        };
      });
      return jsonResult({
        ...run,
        lastGate: slimGate(run.lastGate),
        unackedByRole: ctx.db.countUnackedByRole(runId),
        lastHookEvents: hooks,
      });
    },
  );
}
