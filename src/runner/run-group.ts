import type { Db } from '../db.js';
import { repoFromPath } from '../github.js';
import { CLAIM_LABEL, type RunnerIssue, readIssue, releaseIssue } from './github.js';
import type { HarnessName } from './harness.js';
import { EXIT_BLOCKED, EXIT_DONE, EXIT_ERROR, type RunPbiEvent, runPbi } from './run-pbi.js';
import { type RunPlanEvent, runPlan } from './run-plan.js';

/**
 * `dromos run feature|epic <nr>`: plans the Features that have no PBIs yet, then runs every PBI that is
 * approved, open, unclaimed and not blocked by an open issue, in dependency order, one after another
 * as `dromos run pbi` does. Never waits for a human: planner questions go to the issue (exit 2 of the
 * plan run), unapproved, claimed and blocked PBIs are skipped and listed in the final report. State
 * lives on GitHub, so an interrupted run is resumed by starting it again. Exit codes: 0 every
 * selected PBI opened a PR, 1 at least one PBI run was blocked or failed, 3 error, 130 interrupted.
 */

export type GroupLevel = 'feature' | 'epic';

export const APPROVED_LABEL = 'approved';
export const EXIT_INTERRUPTED = 130;

export interface GroupResult {
  issue: number;
  title: string;
  /** Exit code of the PBI run. */
  code: number;
}

export interface GroupSkip {
  issue: number;
  title: string;
  reason: string;
}

export type RunGroupEvent =
  | { type: 'group.step'; step: string }
  | {
      type: 'group.finished';
      outcome: 'done' | 'interrupted' | 'error';
      reason?: string;
      ran: GroupResult[];
      skipped: GroupSkip[];
    };

/** Everything that touches `gh` or starts a nested run; replaced in unit tests. */
export interface RunGroupOps {
  repoSlug: (repo: string) => Promise<string>;
  readIssue: (slug: string, number: number) => Promise<RunnerIssue>;
  /** Plans a Feature into PBIs; resolves to the exit code of `dromos run plan`. */
  plan: (issue: number) => Promise<number>;
  /** Runs one PBI; resolves to the exit code of `dromos run pbi`. */
  runPbi: (issue: number) => Promise<number>;
}

export interface RunGroupOptions {
  level: GroupLevel;
  issue: number;
  repo: string;
  /** Defaults to `harness` of `.dromos/config.json`. */
  harness?: HarnessName;
  /** Also run PBIs that carry the claim label. */
  force?: boolean;
  emit: (event: RunGroupEvent) => void;
  /** Events of the nested `run pbi` and `run plan` runs. */
  emitPbi?: (event: RunPbiEvent) => void;
  emitPlan?: (event: RunPlanEvent) => void;
  /** Aborted on Ctrl-C: the running PBI finishes unwinding, no further PBI starts. */
  signal?: AbortSignal;
  /** Called with the PBI that is running now, `null` between PBIs (lets Ctrl-C release its claim). */
  onCurrent?: (issue: number | null) => void;
  db?: Db;
  now?: () => Date;
  ops?: Partial<RunGroupOps>;
}

const isOpen = (i: { state: string }): boolean => i.state.toLowerCase() === 'open';
const titled = (prefix: string, title: string): boolean =>
  new RegExp(`^\\[${prefix}\\]`, 'i').test(title);

/**
 * Orders PBIs so that a PBI comes after the PBIs of the list it is blocked by; otherwise the input
 * order is kept. PBIs in a cycle keep their input order at the end.
 */
export function dependencyOrder(pbis: RunnerIssue[]): RunnerIssue[] {
  const inSet = new Set(pbis.map((p) => p.number));
  const done = new Set<number>();
  const ordered: RunnerIssue[] = [];
  let rest = [...pbis];
  while (rest.length > 0) {
    const ready = rest.filter((p) =>
      p.blockedBy.every((b) => !inSet.has(b.number) || done.has(b.number)),
    );
    if (ready.length === 0) break;
    const next = ready[0] as RunnerIssue;
    ordered.push(next);
    done.add(next.number);
    rest = rest.filter((p) => p !== next);
  }
  return [...ordered, ...rest];
}

/** Why `pbi` cannot run now, or `null` when it can. The approval is the PBI's or its Feature's. */
export function skipReason(pbi: RunnerIssue, feature: RunnerIssue, force: boolean): string | null {
  if (!pbi.labels.includes(APPROVED_LABEL) && !feature.labels.includes(APPROVED_LABEL)) {
    return `not approved (label '${APPROVED_LABEL}' on the PBI or on Feature #${String(feature.number)})`;
  }
  if (pbi.labels.includes(CLAIM_LABEL) && !force) return `claimed ('${CLAIM_LABEL}')`;
  const open = pbi.blockedBy.filter(isOpen);
  if (open.length > 0) return `blocked by ${open.map((b) => `#${String(b.number)}`).join(', ')}`;
  return null;
}

/** Runs a Feature or an Epic and resolves to the process exit code. */
export async function runGroup(options: RunGroupOptions): Promise<number> {
  const ops: RunGroupOps = {
    repoSlug: repoFromPath,
    readIssue,
    plan: (issue) =>
      runPlan({
        issue,
        repo: options.repo,
        harness: options.harness,
        // No prompt: open questions go to the issue and the Feature is skipped.
        resolve: {},
        db: options.db,
        now: options.now,
        emit: options.emitPlan ?? (() => undefined),
      }),
    runPbi: (issue) =>
      runPbi({
        issue,
        repo: options.repo,
        harness: options.harness,
        force: options.force,
        db: options.db,
        now: options.now,
        emit: options.emitPbi ?? (() => undefined),
      }),
    ...options.ops,
  };
  const ran: GroupResult[] = [];
  const skipped: GroupSkip[] = [];
  const step = (text: string): void => options.emit({ type: 'group.step', step: text });
  const finish = (outcome: 'done' | 'interrupted' | 'error', code: number, reason?: string) => {
    options.emit({ type: 'group.finished', outcome, ...(reason ? { reason } : {}), ran, skipped });
    return code;
  };
  const interrupted = () => options.signal?.aborted === true;

  try {
    const slug = await ops.repoSlug(options.repo);
    const root = await ops.readIssue(slug, options.issue);
    const wanted = options.level === 'feature' ? 'Feature' : 'Epic';
    if (!titled(wanted, root.title)) {
      throw new Error(`#${String(root.number)} is not a ${wanted}: '${root.title}'`);
    }

    // Features of the run; the PBIs directly under an Epic count as a Feature of their own.
    const featureRefs =
      options.level === 'feature'
        ? [root.number]
        : root.subIssues
            .filter((s) => isOpen(s) && titled('Feature', s.title))
            .map((s) => s.number);
    const features: RunnerIssue[] = [];
    if (options.level === 'epic' && root.subIssues.some((s) => titled('PBI', s.title))) {
      features.push(root);
    }
    for (const number of featureRefs) {
      if (interrupted()) return finish('interrupted', EXIT_INTERRUPTED);
      let feature = number === root.number ? root : await ops.readIssue(slug, number);
      if (feature.subIssues.length === 0) {
        step(`plan Feature #${String(number)}`);
        const code = await ops.plan(number);
        if (code !== EXIT_DONE) {
          skipped.push({
            issue: number,
            title: feature.title,
            reason:
              code === 2
                ? 'planner questions open (needs-decision)'
                : `planning failed (exit ${String(code)})`,
          });
          continue;
        }
        feature = await ops.readIssue(slug, number);
      }
      features.push(feature);
    }

    const candidates: { pbi: RunnerIssue; feature: RunnerIssue }[] = [];
    for (const feature of features) {
      for (const ref of feature.subIssues.filter((s) => isOpen(s) && titled('PBI', s.title))) {
        candidates.push({ pbi: await ops.readIssue(slug, ref.number), feature });
      }
    }
    const featureOf = new Map(candidates.map((c) => [c.pbi.number, c.feature]));
    for (const listed of dependencyOrder(candidates.map((c) => c.pbi))) {
      if (interrupted()) return finish('interrupted', EXIT_INTERRUPTED);
      // Re-read: an earlier PBI of this run may have opened a PR, another run may have claimed it.
      const pbi = await ops.readIssue(slug, listed.number);
      const reason = skipReason(pbi, featureOf.get(listed.number) as RunnerIssue, !!options.force);
      if (reason) {
        skipped.push({ issue: pbi.number, title: pbi.title, reason });
        continue;
      }
      step(`run PBI #${String(pbi.number)}`);
      options.onCurrent?.(pbi.number);
      const code = await ops.runPbi(pbi.number);
      options.onCurrent?.(null);
      ran.push({ issue: pbi.number, title: pbi.title, code });
    }
    if (interrupted()) return finish('interrupted', EXIT_INTERRUPTED);
    return finish('done', ran.every((r) => r.code === EXIT_DONE) ? EXIT_DONE : EXIT_BLOCKED);
  } catch (error) {
    return finish('error', EXIT_ERROR, error instanceof Error ? error.message : String(error));
  }
}

/** Removes the claim of the PBI a hard-interrupted run left behind. */
export async function releaseClaim(repo: string, issue: number): Promise<void> {
  await releaseIssue(await repoFromPath(repo), issue);
}
