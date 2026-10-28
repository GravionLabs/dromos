import type { Db } from '../db.js';
import { BusEventSchema } from '../events/schema.js';
import { repoFromPath } from '../github.js';
import { loadRunnerConfig, modelFor, ROLES, type Role, type RunnerConfig } from './config.js';
import { resolveFormatter } from './format.js';
import {
  type BranchType,
  finishRunWorktree,
  openRunWorktree,
  pushRunBranch,
  type RunWorktree,
} from './git.js';
import {
  ClaimError,
  type CreatePrInput,
  claimIssue,
  comment,
  createPr,
  type PullRequest,
  type RunnerIssue,
  readIssue,
  releaseIssue,
} from './github.js';
import { CliHarness } from './harness/cli.js';
import type { Harness, HarnessName } from './harness.js';
import {
  type ImplementerEvent,
  type PbiSpec,
  runImplementerPhase,
  type TestOutcome,
} from './implementer.js';
import { createPermissions } from './permissions.js';
import { type Commit, runReviewPhase } from './review.js';
import { INITIAL_STATE, isTerminal, transition } from './state-machine.js';

/**
 * `dromos run pbi <nr>`: claims the PBI, cuts a worktree, runs the implementer and reviewer phases and
 * opens the pull request. Every step is reported through `emit`; the first event is always the run
 * header. Exit codes: 0 done (PR opened), 1 blocked, 3 error.
 */

export const EXIT_DONE = 0;
export const EXIT_BLOCKED = 1;
export const EXIT_ERROR = 3;

const TIMEOUT_MS = 30 * 60 * 1000;
const SOURCE = 'dromos';

export interface RunHeader {
  type: 'run.header';
  runId: string;
  issue: number;
  repo: string;
  harness: { name: HarnessName; version: string | null; sdk: string | null };
  models: Record<Role, string>;
  dryRun: boolean;
}

export type RunPbiEvent =
  | RunHeader
  | ImplementerEvent
  | { type: 'run.step'; step: string }
  | {
      type: 'run.finished';
      outcome: 'pr_opened' | 'blocked' | 'dry_run' | 'error';
      reason?: string;
      pr?: PullRequest & { draft: boolean };
    };

/** Everything that touches `gh`, git or a harness; replaced in unit tests. */
export interface RunPbiOps {
  repoSlug: (repo: string) => Promise<string>;
  readIssue: (slug: string, number: number) => Promise<RunnerIssue>;
  claimIssue: typeof claimIssue;
  releaseIssue: typeof releaseIssue;
  openWorktree: typeof openRunWorktree;
  finishWorktree: typeof finishRunWorktree;
  pushBranch: typeof pushRunBranch;
  makeHarness: (name: HarnessName) => Harness & { version(): Promise<string | null> };
  createPr: (repo: string, input: CreatePrInput) => Promise<PullRequest>;
  comment: (repo: string, number: number, body: string) => Promise<void>;
  runTests?: (command: string, cwd: string) => Promise<TestOutcome>;
  runFormat?: (command: string, cwd: string) => Promise<TestOutcome>;
  listCommits?: (base: string, cwd: string) => Promise<Commit[]>;
}

export interface RunPbiOptions {
  issue: number;
  repo: string;
  /** Defaults to `harness` of `.dromos/config.json`. */
  harness?: HarnessName;
  dryRun?: boolean;
  force?: boolean;
  emit: (event: RunPbiEvent) => void;
  /** `phase.*` events are stored here with the run id. */
  db?: Db;
  now?: () => Date;
  ops?: Partial<RunPbiOps>;
}

const defaultOps: RunPbiOps = {
  repoSlug: repoFromPath,
  readIssue,
  claimIssue,
  releaseIssue,
  openWorktree: openRunWorktree,
  finishWorktree: finishRunWorktree,
  pushBranch: pushRunBranch,
  makeHarness: (name) => new CliHarness({ name }),
  createPr,
  comment,
};

/** The text of the `## Acceptance Criteria` section, `''` when the issue has none. */
export function acceptanceCriteria(body: string): string {
  const m = /^##\s+Acceptance Criteria\s*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/im.exec(body);
  return m?.[1]?.trim() ?? '';
}

const TITLE_PREFIX = /^(?:\[[^\]]*\]\s*)?(?:(feat|fix|chore|docs|ci)(?:\([^)]*\))?!?:\s*)?/i;

/** Branch type and plain title of an issue title such as `[PBI] feat: add x`. */
export function parseTitle(title: string): { type: BranchType; title: string } {
  const m = TITLE_PREFIX.exec(title);
  return {
    type: (m?.[1]?.toLowerCase() as BranchType | undefined) ?? 'feat',
    title: title.slice(m?.[0].length ?? 0).trim() || title,
  };
}

async function pbiSpec(slug: string, issue: RunnerIssue, ops: RunPbiOps): Promise<PbiSpec> {
  const open = issue.subIssues.filter((s) => s.state.toLowerCase() === 'open');
  const tasks = await Promise.all(open.map((s) => ops.readIssue(slug, s.number)));
  return {
    number: issue.number,
    title: issue.title,
    acceptanceCriteria: acceptanceCriteria(issue.body),
    body: issue.body,
    tasks: tasks.map((t) => ({
      number: t.number,
      title: t.title,
      body: t.body,
      blockedBy: t.blockedBy.map((b) => b.number),
    })),
  };
}

function modelsOf(config: RunnerConfig, harness: HarnessName): Record<Role, string> {
  return Object.fromEntries(ROLES.map((r) => [r, modelFor(config, harness, r)])) as Record<
    Role,
    string
  >;
}

/** Runs one PBI and resolves to the process exit code. */
export async function runPbi(options: RunPbiOptions): Promise<number> {
  const ops: RunPbiOps = { ...defaultOps, ...options.ops };
  const now = options.now ?? (() => new Date());
  const config = loadRunnerConfig(options.repo);
  const harnessName = options.harness ?? config.harness;
  const runId = `pbi-${String(options.issue)}-${now().getTime().toString(36)}`;
  const dryRun = options.dryRun === true;

  // A dry run never starts a harness binary, not even for `--version`.
  const harness = dryRun ? null : ops.makeHarness(harnessName);
  const info = { name: harnessName, version: (await harness?.version()) ?? null, sdk: null };
  const slug = await ops.repoSlug(options.repo);
  options.emit({
    type: 'run.header',
    runId,
    issue: options.issue,
    repo: slug,
    harness: info,
    models: modelsOf(config, harnessName),
    dryRun,
  });

  const emit = (event: ImplementerEvent): void => {
    options.emit(event);
    // Format events go to the caller only; the bus has no schema for them.
    if (options.db && 'data' in event && !event.type.startsWith('format.')) {
      const checked = BusEventSchema.parse({
        id: 0,
        type: event.type,
        at: now().toISOString(),
        source: SOURCE,
        agentId: null,
        issue: options.issue,
        runId,
        // The phases carry the harness id for model lookup; the bus event has name, version and sdk only.
        data: event.type.startsWith('phase.')
          ? { ...event.data, harness: { name: info.name, version: info.version, sdk: info.sdk } }
          : event.data,
      });
      options.db.insertEvent(SOURCE, checked.type, checked.data, {
        issue: options.issue,
        runId,
      });
    }
  };
  const step = (text: string): void => options.emit({ type: 'run.step', step: text });
  const finish = (
    outcome: 'pr_opened' | 'blocked' | 'dry_run' | 'error',
    code: number,
    extra: { reason?: string; pr?: PullRequest & { draft: boolean } } = {},
  ): number => {
    options.emit({ type: 'run.finished', outcome, ...extra });
    return code;
  };

  let claimed = false;
  let worktree: RunWorktree | undefined;
  try {
    const issue = await ops.readIssue(slug, options.issue);
    const pbi = await pbiSpec(slug, issue, ops);
    const open = issue.blockedBy.filter((b) => b.state.toLowerCase() === 'open');
    if (open.length > 0) {
      return finish('blocked', EXIT_BLOCKED, {
        reason: `blocked by ${open.map((b) => `#${String(b.number)}`).join(', ')}`,
      });
    }
    const parsed = parseTitle(issue.title);

    if (dryRun) {
      step(
        `claim #${String(pbi.number)} with label in-progress${options.force ? ' (--force)' : ''}`,
      );
      step(
        `create worktree and branch ${parsed.type}/${String(pbi.number)}-… from the integration branch`,
      );
      if (pbi.tasks.length === 0) step(`implement #${String(pbi.number)} in one session`);
      for (const t of pbi.tasks) step(`implement Task #${String(t.number)}: ${t.title}`);
      const formatter = await resolveFormatter(config, options.repo);
      step(
        formatter === 'disabled'
          ? 'format changed files: disabled'
          : `format changed files before the tests: ${formatter?.describe ?? 'no formatter detected, skipped'}`,
      );
      step(`run tests: ${config.test.related ?? config.test.full}`);
      step(`review, at most ${String(config.maxFixRounds)} fix round(s)`);
      step('open the pull request, release the claim, remove the worktree');
      return finish('dry_run', EXIT_DONE);
    }

    await ops.claimIssue(slug, options.issue, runId, options.force);
    claimed = true;
    worktree = await ops.openWorktree(options.repo, options.issue, parsed.type, parsed.title);
    const permissions = createPermissions({ cwd: worktree.path, allow: config.allow });
    const deps = {
      harness: harness as Harness,
      harnessInfo: { ...info, id: harnessName },
      config,
      cwd: worktree.path,
      skillDirs: [...config.skills.implementer, ...config.skills.reviewer],
      allow: permissions.allow,
      timeoutMs: TIMEOUT_MS,
      runTests: ops.runTests,
      runFormat: ops.runFormat,
      base: worktree.base,
      emit,
    };

    let state = transition(INITIAL_STATE, { type: 'start' }, config.maxFixRounds);
    emit(state.event);
    const implemented = await runImplementerPhase(deps, pbi, {
      kind: 'implementing',
      round: 0,
    });
    state = implemented;
    let pr: (PullRequest & { draft: boolean }) | undefined;
    if (state.state.kind === 'reviewing') {
      const opened = worktree;
      const reviewed = await runReviewPhase(
        {
          ...deps,
          repo: slug,
          base: worktree.base,
          branch: worktree.branch,
          github: {
            createPr: async (repo, input) => {
              await ops.pushBranch(opened);
              return ops.createPr(repo, input);
            },
            comment: ops.comment,
          },
          listCommits: ops.listCommits,
        },
        pbi,
        state.state,
      );
      state = reviewed;
      pr = reviewed.pr;
    }
    if (isTerminal(state.state)) {
      const done = state.state.kind === 'pr_opened';
      await ops.releaseIssue(slug, options.issue);
      claimed = false;
      await ops.finishWorktree(options.repo, worktree, done ? 'pr_opened' : 'blocked');
      return done
        ? finish('pr_opened', EXIT_DONE, { pr })
        : finish('blocked', EXIT_BLOCKED, {
            reason: state.state.kind === 'blocked' ? state.state.reason : undefined,
            pr,
          });
    }
    throw new Error(`run ended in non-terminal state ${state.state.kind}`);
  } catch (error) {
    if (claimed) await ops.releaseIssue(slug, options.issue).catch(() => undefined);
    const reason = error instanceof Error ? error.message : String(error);
    return finish(
      error instanceof ClaimError ? 'blocked' : 'error',
      error instanceof ClaimError ? EXIT_BLOCKED : EXIT_ERROR,
      {
        reason,
      },
    );
  }
}
