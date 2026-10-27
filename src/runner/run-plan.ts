import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Db } from '../db.js';
import { BusEventSchema } from '../events/schema.js';
import { repoFromPath } from '../github.js';
import { loadRunnerConfig, modelFor } from './config.js';
import { type RunnerIssue, readIssue } from './github.js';
import { CliHarness } from './harness/cli.js';
import type { Harness, HarnessName } from './harness.js';
import type { PhaseEnd, PhaseEventData } from './implementer.js';
import { createPermissions } from './permissions.js';
import {
  type CreatedIssue,
  createPlanIssues,
  type Plan,
  type PlanLevel,
  runPlannerPhase,
} from './planner.js';
import { type ResolveOptions, resolveQuestions, withAssumptions } from './questions.js';
import { EXIT_BLOCKED, EXIT_DONE, EXIT_ERROR } from './run-pbi.js';

/**
 * `dromos run plan <nr>`: runs the planner phase on a Feature or PBI, resolves its questions (by
 * `--answer`, `--assume-recommended` or a select prompt on a TTY), writes the plan with the taken
 * recommendations as assumptions and creates the issues one level down. Open questions stop the run
 * before any issue is created. Exit codes: 0 issues created, 1 questions open, 3 error.
 */

const TIMEOUT_MS = 30 * 60 * 1000;
const SOURCE = 'dromos';

export type RunPlanEvent =
  | { type: 'phase.started'; data: PhaseEventData }
  | { type: 'phase.finished'; data: PhaseEnd & { unansweredQuestions: number } }
  | { type: 'phase.failed'; data: PhaseEnd }
  | {
      type: 'run.finished';
      outcome: 'planned' | 'questions_open' | 'error';
      reason?: string;
      plan?: string;
      issues?: CreatedIssue[];
    };

/** Everything that touches `gh`, the file system or a harness; replaced in unit tests. */
export interface RunPlanOps {
  repoSlug: (repo: string) => Promise<string>;
  readIssue: (slug: string, number: number) => Promise<RunnerIssue>;
  makeHarness: (name: HarnessName) => Harness & { version(): Promise<string | null> };
  createIssues: typeof createPlanIssues;
  writePlan: (path: string, plan: Plan) => void;
}

export interface RunPlanOptions {
  issue: number;
  repo: string;
  /** Defaults to `harness` of `.dromos/config.json`. */
  harness?: HarnessName;
  /** Answers, `--assume-recommended` and the TTY prompt. */
  resolve?: ResolveOptions;
  emit: (event: RunPlanEvent) => void;
  /** `phase.*` events are stored here with the run id. */
  db?: Db;
  now?: () => Date;
  ops?: Partial<RunPlanOps>;
}

const defaultOps: RunPlanOps = {
  repoSlug: repoFromPath,
  readIssue,
  makeHarness: (name) => new CliHarness({ name }),
  createIssues: createPlanIssues,
  writePlan: (path, plan) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(plan, null, 2)}\n`);
  },
};

/** Where the plan of `issue` is written inside the target repository. */
export function planPath(repo: string, issue: number): string {
  return join(repo, '.dromos', 'state', String(issue), 'plan.json');
}

/** A Feature is planned into PBIs, a PBI into Tasks; other titles cannot be planned. */
export function planLevel(title: string): PlanLevel {
  if (/^\[Feature\]/i.test(title)) return 'PBI';
  if (/^\[PBI\]/i.test(title)) return 'Task';
  throw new Error(`cannot plan '${title}': the title must start with [Feature] or [PBI]`);
}

/** Plans one issue and resolves to the process exit code. */
export async function runPlan(options: RunPlanOptions): Promise<number> {
  const ops: RunPlanOps = { ...defaultOps, ...options.ops };
  const now = options.now ?? (() => new Date());
  const config = loadRunnerConfig(options.repo);
  const harnessName = options.harness ?? config.harness;
  const runId = `plan-${String(options.issue)}-${now().getTime().toString(36)}`;
  const finish = (
    outcome: 'planned' | 'questions_open' | 'error',
    code: number,
    extra: { reason?: string; plan?: string; issues?: CreatedIssue[] } = {},
  ): number => {
    options.emit({ type: 'run.finished', outcome, ...extra });
    return code;
  };

  try {
    const harness = ops.makeHarness(harnessName);
    const info = {
      name: harnessName,
      version: await harness.version(),
      sdk: null,
    };
    const slug = await ops.repoSlug(options.repo);
    const emit = (event: RunPlanEvent): void => {
      options.emit(event);
      if (options.db && 'data' in event) {
        const checked = BusEventSchema.parse({
          id: 0,
          type: event.type,
          at: now().toISOString(),
          source: SOURCE,
          agentId: null,
          issue: options.issue,
          runId,
          data: event.data,
        });
        options.db.insertEvent(SOURCE, checked.type, checked.data, {
          issue: options.issue,
          runId,
        });
      }
    };

    const issue = await ops.readIssue(slug, options.issue);
    const level = planLevel(issue.title);
    const model = modelFor(config, harnessName, 'planner');
    const base = { phase: 'planner', harness: info, model };
    emit({ type: 'phase.started', data: base });
    const start = now().getTime();
    const end = () => ({ ...base, durationMs: now().getTime() - start });
    let planned: Awaited<ReturnType<typeof runPlannerPhase>>;
    try {
      planned = await runPlannerPhase({
        harness,
        cwd: options.repo,
        model,
        skills: config.skills.planner,
        allow: createPermissions({ cwd: options.repo, allow: config.allow }).allow,
        timeoutMs: TIMEOUT_MS,
        issue: { number: issue.number, title: issue.title, body: issue.body },
        level,
      });
    } catch (error) {
      emit({ type: 'phase.failed', data: { ...end(), usage: null } });
      throw error;
    }
    const duration = end();
    const resolution = await resolveQuestions(planned.plan, options.resolve);
    const plan = withAssumptions(planned.plan, resolution);
    const path = planPath(options.repo, options.issue);
    ops.writePlan(path, plan);
    const unanswered = resolution.unanswered.length;
    emit({
      type: 'phase.finished',
      data: {
        ...duration,
        usage: planned.usage,
        unansweredQuestions: unanswered,
      },
    });
    if (unanswered > 0) {
      return finish('questions_open', EXIT_BLOCKED, {
        reason: `${String(unanswered)} open question(s): ${resolution.unanswered.map((q) => q.id).join(', ')}; answer with --answer <id>=<value> or --assume-recommended`,
        plan: path,
      });
    }
    const issues = await ops.createIssues(slug, options.issue, level, plan, plan.assumptions);
    return finish('planned', EXIT_DONE, { plan: path, issues });
  } catch (error) {
    return finish('error', EXIT_ERROR, {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}
