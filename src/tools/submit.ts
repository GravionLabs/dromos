import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execa } from 'execa';
import { z } from 'zod';
import { requireRole } from '../auth.js';
import type { ToolContext } from '../context.js';
import type { EventRecord, Run } from '../db.js';
import { resolveGateCommands, runGate } from '../gate.js';
import { publishRows, recordRunTransition } from '../run-events.js';
import { afterRunTransition } from '../run-lease.js';
import type { GateResult, MessageType, Role, RunState } from '../schemas.js';
import { transition } from '../state-machine.js';
import { errorResult, jsonResult, logAndWake } from './util.js';

/**
 * Background gates by run id; tests await these to observe completion.
 * Known limitation: gates live in memory only. If the bus restarts while a run is in 'gating',
 * the run stays there; startup recovery of such runs is a follow-up outside this PBI.
 */
export const pendingGates = new Map<string, Promise<void>>();

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

const GIT_TIMEOUT_MS = 30_000;

async function git(worktreePath: string, ...args: string[]): Promise<string> {
  const { stdout } = await execa('git', ['-C', worktreePath, ...args], {
    timeout: GIT_TIMEOUT_MS,
  });
  return String(stdout).trim();
}

/** A failed single-step gate describing why the real gate could not produce a result. */
const failedGate = (name: string, outputTail: string): GateResult => ({
  passed: false,
  steps: [{ name, command: '', exitCode: 1, durationMs: 0, outputTail }],
});

async function evaluateGate(ctx: ToolContext, run: Run): Promise<GateResult> {
  try {
    const commands = resolveGateCommands(run.worktreePath, ctx.config.gate.commands);
    return await runGate(commands, run.worktreePath, ctx.config.gate.timeoutSeconds);
  } catch (err) {
    ctx.log.logLine('ERROR', `${run.id} gate crashed: ${errorMessage(err)}`);
    return failedGate('gate', `gate crashed: ${errorMessage(err)}`);
  }
}

/** Leaves plain paths and refs untouched (spec form) and single-quotes anything else. */
const shellArg = (value: string) =>
  /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;

type Outbound = {
  from: Role;
  to: Role;
  type: MessageType;
  state: RunState;
  /** Stored run events, published once the transaction committed. */
  rows: EventRecord[];
};

/** Persists the gate outcome, state change and outgoing message atomically. */
function applyGateResult(ctx: ToolContext, run: Run, summary: string, gate: GateResult): Outbound {
  const next = transition(
    run,
    { type: gate.passed ? 'gate_passed' : 'gate_failed' },
    ctx.config.maxRounds,
  );
  ctx.db.updateRun(run.id, { lastGate: gate, state: next.state, round: next.round });
  // The bus ran the gate itself, so a red gate's outcome is verified.
  const rows = recordRunTransition(
    ctx.db,
    run,
    run,
    next,
    gate.passed
      ? undefined
      : { outcome: next.state === 'blocked' ? 'blocked' : 'gate_failed', evidence: 'verified' },
  );
  const runId = run.id;
  if (gate.passed) {
    ctx.db.insertMessage({
      from: 'implementer',
      to: 'reviewer',
      type: 'review_request',
      runId,
      payload: {
        runId,
        worktreePath: run.worktreePath,
        branch: run.branch,
        baseBranch: run.baseBranch,
        issue: { number: run.issueNumber, title: run.issueTitle },
        implementationSummary: summary,
        diffCommand: `git -C ${shellArg(run.worktreePath)} diff origin/${run.baseBranch}...HEAD`,
        instructions: 'Review the diff read-only. Call submit_review.',
      },
    });
    return {
      from: 'implementer',
      to: 'reviewer',
      type: 'review_request',
      state: next.state,
      rows,
    };
  }
  if (next.state === 'blocked') {
    ctx.db.insertMessage({
      from: 'implementer',
      to: 'orchestrator',
      type: 'notice',
      runId,
      payload: { runId, reason: 'round limit reached', lastGate: gate },
    });
    return { from: 'implementer', to: 'orchestrator', type: 'notice', state: next.state, rows };
  }
  // A red gate without steps still names a failed step and a non-zero exit code.
  const failed = gate.steps.find((step) => step.exitCode !== 0) ??
    gate.steps.at(-1) ?? { name: 'gate', exitCode: 1, outputTail: 'gate reported no steps' };
  ctx.db.insertMessage({
    from: 'orchestrator',
    to: 'implementer',
    type: 'gate_result',
    runId,
    payload: {
      runId,
      round: next.round,
      failedStep: failed.name,
      exitCode: failed.exitCode,
      outputTail: failed.outputTail,
    },
  });
  return {
    from: 'orchestrator',
    to: 'implementer',
    type: 'gate_result',
    state: next.state,
    rows,
  };
}

async function handleGateResult(
  ctx: ToolContext,
  runId: string,
  summary: string,
  gate: GateResult,
): Promise<void> {
  const run = ctx.db.getRun(runId);
  if (run?.state !== 'gating') {
    ctx.log.logLine('ERROR', `${runId} gate result dropped: run is in state ${run?.state}`);
    return;
  }
  const out = ctx.db.transaction(() => applyGateResult(ctx, run, summary, gate));
  void afterRunTransition(ctx, { ...run, state: out.state });
  // The outcome is committed: logging must not trigger the gate_failed fallback or skip the wake.
  try {
    publishRows(ctx.events, out.rows);
  } catch (err) {
    ctx.log.logLine('ERROR', `${runId} could not publish the run events: ${errorMessage(err)}`);
  }
  try {
    const after = ctx.db.getRun(runId);
    ctx.log.logLine('GATE', `${runId} ${gate.passed ? 'passed' : 'failed'}`);
    ctx.log.logLine('STATE', `${runId} ${after?.state} (round ${after?.round})`);
  } catch (err) {
    ctx.log.logLine('ERROR', `${runId} could not log the gate outcome: ${errorMessage(err)}`);
  }
  logAndWake(ctx, out.from, out.to, out.type, runId);
}

async function runInBackground(ctx: ToolContext, run: Run, summary: string): Promise<void> {
  try {
    const gate = await evaluateGate(ctx, run);
    await handleGateResult(ctx, run.id, summary, gate);
  } catch (err) {
    // Spec: log every background error as ERROR and treat it as gate_failed, so the run
    // leaves gating (implementing with round + 1, or blocked on the last round).
    ctx.log.logLine('ERROR', `${run.id} gate handling failed: ${errorMessage(err)}`);
    try {
      await handleGateResult(
        ctx,
        run.id,
        summary,
        failedGate('gate', `gate handling failed: ${errorMessage(err)}`),
      );
    } catch (fallbackErr) {
      // Known limit: the spec defines a single gate_failed fallback. If even that cannot be
      // stored (database refuses writes), the run stays in 'gating' and needs a human.
      ctx.log.logLine(
        'ERROR',
        `${run.id} gate_failed handling failed: ${errorMessage(fallbackErr)}`,
      );
    }
  } finally {
    pendingGates.delete(run.id);
  }
}

export function registerSubmitTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'submit_implementation',
    {
      description:
        'Implementer only. Hand in committed work. The bus runs the build/test/lint gate in the ' +
        'background and sends the result as a message; returns immediately with gate_started.',
      inputSchema: {
        runId: z.string().min(1).describe('Run id'),
        summary: z.string().min(1).max(5000).describe('What was implemented'),
      },
    },
    async ({ runId, summary }) => {
      requireRole('submit_implementation', ctx.role, 'implementer');
      const run = ctx.db.getRun(runId);
      if (!run) return errorResult(`unknown run: ${runId}`);
      if (run.state !== 'implementing') {
        return errorResult(
          `run ${runId} is in state '${run.state}', submit_implementation needs 'implementing'`,
        );
      }
      try {
        if ((await git(run.worktreePath, 'status', '--porcelain')) !== '') {
          return errorResult('uncommitted changes in the worktree: commit everything first');
        }
        const ahead = Number(
          await git(run.worktreePath, 'rev-list', '--count', `origin/${run.baseBranch}..HEAD`),
        );
        if (!(ahead > 0)) {
          return errorResult(
            `no commits ahead of origin/${run.baseBranch}: commit your work first`,
          );
        }
      } catch (err) {
        return errorResult(`could not inspect the worktree: ${errorMessage(err)}`);
      }
      // Re-read: the run may have moved while git was running. The check and the transition
      // below run synchronously, so two concurrent submits cannot both start a gate.
      const fresh = ctx.db.getRun(runId);
      if (fresh?.state !== 'implementing') {
        return errorResult(`run ${runId} is no longer in state 'implementing'`);
      }
      const next = transition(fresh, { type: 'implementation_submitted' }, ctx.config.maxRounds);
      const rows = ctx.db.transaction(() => {
        ctx.db.updateRun(runId, {
          state: next.state,
          round: next.round,
          lastSummary: summary,
        });
        return recordRunTransition(ctx.db, fresh, fresh, next);
      });
      // Start the gate right after the commit so a logging failure cannot strand the run in gating.
      pendingGates.set(runId, runInBackground(ctx, fresh, summary));
      void afterRunTransition(ctx, { ...fresh, state: next.state });
      try {
        publishRows(ctx.events, rows);
      } catch (err) {
        ctx.log.logLine('ERROR', `${runId} could not publish the run events: ${errorMessage(err)}`);
      }
      try {
        ctx.log.logLine('STATE', `${runId} ${next.state} (round ${next.round})`);
      } catch (err) {
        ctx.log.logLine('ERROR', `${runId} could not log the state change: ${errorMessage(err)}`);
      }
      return jsonResult({ status: 'gate_started' });
    },
  );
}
