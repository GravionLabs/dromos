import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Db } from '../db.js';
import { BusEventSchema } from '../events/schema.js';
import { repoFromPath } from '../github.js';
import { APPROVAL_KIND, raiseApproval } from './approval.js';
import { loadRunnerConfig, modelFor } from './config.js';
import {
  addLabel,
  comment,
  NEEDS_DECISION_LABEL,
  type RunnerIssue,
  readComments,
  readIssue,
  removeLabel,
} from './github.js';
import { CliHarness } from './harness/cli.js';
import type { Harness, HarnessName } from './harness.js';
import type { PhaseEnd, PhaseEventData } from './implementer.js';
import type { OutcomeEvent } from './outcome.js';
import { createPermissions } from './permissions.js';
import {
  type CreatedIssue,
  createPlanIssues,
  type Plan,
  type PlanLevel,
  runPlannerPhase,
} from './planner.js';
import {
  parseAnswerComments,
  questionsComment,
  type ResolveOptions,
  resolveQuestions,
  withAssumptions,
} from './questions.js';
import { EXIT_DONE, EXIT_ERROR } from './run-pbi.js';

/** Open questions were posted to the issue as a comment. */
export const EXIT_NEEDS_DECISION = 2;

/**
 * `dromos run plan <nr>`: runs the planner phase on a Feature or PBI, resolves its questions (by
 * `--answer`, `--assume-recommended` or a select prompt on a TTY), writes the plan with the taken
 * recommendations as assumptions and creates the issues one level down. Open questions stop the run
 * before any issue is created: the draft plan and the questions go into one issue comment, the issue
 * gets `needs-decision` and an `attention` event, and the run exits 2. The next run reads
 * `/answer <id> <value>` comments of the issue, removes the label and continues. Exit codes: 0
 * issues created, 2 questions open, 3 error.
 */

const TIMEOUT_MS = 30 * 60 * 1000;
const SOURCE = 'dromos';

export type RunPlanEvent =
  | OutcomeEvent
  | { type: 'phase.started'; data: PhaseEventData }
  | { type: 'phase.finished'; data: PhaseEnd & { unansweredQuestions: number } }
  | { type: 'phase.failed'; data: PhaseEnd }
  | {
      type: 'attention';
      data: { kind: string; summary: string; pr: null; question?: string; options?: string[] };
      /** The issue the attention is about, when it is not the planned one (APPROVAL). */
      issue?: number;
    }
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
  readComments: (slug: string, number: number) => Promise<string[]>;
  comment: (slug: string, number: number, body: string) => Promise<void>;
  addLabel: (slug: string, number: number, label: string) => Promise<void>;
  removeLabel: (slug: string, number: number, label: string) => Promise<void>;
  createIssues: typeof createPlanIssues;
  writePlan: (path: string, plan: Plan) => void;
}

export interface RunPlanOptions {
  issue: number;
  repo: string;
  /** Defaults to `harness` of `.dromos/config.json`. */
  harness?: HarnessName;
  /** `dromos plan feature|pbi`: the issue must be of this kind. */
  kind?: 'Feature' | 'PBI';
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
  readComments,
  comment,
  addLabel,
  removeLabel,
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
          repo: slug,
        });
      }
    };

    const issue = await ops.readIssue(slug, options.issue);
    const level = planLevel(issue.title);
    if (options.kind && level !== (options.kind === 'Feature' ? 'PBI' : 'Task')) {
      throw new Error(`#${String(options.issue)} is not a ${options.kind}: '${issue.title}'`);
    }
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
    // `/answer` comments of the issue; flags win, answers to ids the new plan lacks are ignored.
    const known = new Set(planned.plan.questions.map((q) => q.id));
    const answers = new Map<string, string>();
    for (const [id, value] of parseAnswerComments(await ops.readComments(slug, options.issue))) {
      if (known.has(id)) answers.set(id, value);
    }
    for (const [id, value] of options.resolve?.answers ?? []) answers.set(id, value);
    const resolution = await resolveQuestions(planned.plan, { ...options.resolve, answers });
    const plan = withAssumptions(planned.plan, resolution);
    const path = planPath(options.repo, options.issue);
    ops.writePlan(path, plan);
    const unanswered = resolution.unanswered.length;
    emit({
      type: 'outcome.questions',
      data: {
        count: planned.plan.questions.length,
        assumed: resolution.answered.filter((a) => a.assumed).length,
      },
    });
    emit({
      type: 'phase.finished',
      data: {
        ...duration,
        usage: planned.usage,
        unansweredQuestions: unanswered,
      },
    });
    if (unanswered > 0) {
      const ids = resolution.unanswered.map((q) => q.id).join(', ');
      await ops.comment(slug, options.issue, questionsComment(plan, resolution.unanswered));
      await ops.addLabel(slug, options.issue, NEEDS_DECISION_LABEL);
      const reason = `${String(unanswered)} open question(s): ${ids}; answer with /answer <id> <value> comments on #${String(options.issue)}, --answer <id>=<value> or --assume-recommended`;
      emit({
        type: 'attention',
        data: {
          kind: 'QUESTION',
          summary: reason,
          pr: null,
          question: resolution.unanswered[0]?.question ?? ids,
          options: resolution.unanswered[0]?.options ?? [],
        },
      });
      return finish('questions_open', EXIT_NEEDS_DECISION, { reason, plan: path });
    }
    if (issue.labels.includes(NEEDS_DECISION_LABEL)) {
      await ops.removeLabel(slug, options.issue, NEEDS_DECISION_LABEL);
    }
    const issues = await ops.createIssues(slug, options.issue, level, plan, plan.assumptions);
    // One APPROVAL attention per created issue (`needs-approval`); a later run acks it on `approved`:
    // `run feature|epic` for Features and PBIs, `run pbi` for the Tasks of its PBI.
    for (const created of issues) {
      const item = plan.items.find((i) => i.key === created.key);
      if (!item) continue;
      const summary = `[${level}] ${item.title}`;
      if (options.db) {
        raiseApproval(options.db, {
          repo: slug,
          issue: created.number,
          runId,
          level,
          title: item.title,
        });
      }
      options.emit({
        type: 'attention',
        data: { kind: APPROVAL_KIND, summary, pr: null },
        issue: created.number,
      });
    }
    return finish('planned', EXIT_DONE, { plan: path, issues });
  } catch (error) {
    return finish('error', EXIT_ERROR, {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}
