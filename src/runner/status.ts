import { execa } from 'execa';
import type { Db, EventRecord } from '../db.js';
import { CLAIM_LABEL, NEEDS_DECISION_LABEL, type RunnerIssue, readIssue } from './github.js';
import { NEEDS_APPROVAL_LABEL } from './planner.js';
import { APPROVED_LABEL } from './run-group.js';

/**
 * `dromos status <nr>`: one table for an Epic, Feature or PBI, read from GitHub and the local event
 * store only (nothing is written). Rows: the issue, its children and, for an Epic, the PBIs of its
 * Features; per row the open/closed state, the workflow labels, open blockers, the pull request of
 * the issue's branch and the last runner run (header from its `phase.*` events). Replaces the status
 * table of the apm-hub orchestrator (`Write-StatusTable.ps1`).
 */

export const STATUS_LABELS = [
  NEEDS_APPROVAL_LABEL,
  APPROVED_LABEL,
  CLAIM_LABEL,
  NEEDS_DECISION_LABEL,
] as const;

const PHASE_EVENTS = ['phase.started', 'phase.finished', 'phase.failed'];
const PAGE = 1000;

export interface StatusPr {
  number: number;
  url: string;
  /** `open`, `draft`, `merged` or `closed`. */
  state: string;
}

export interface LastRun {
  runId: string;
  at: string;
  harness: { name: string; version: string | null; sdk: string | null } | null;
  /** Model per phase, from the run's `phase.started` events. */
  models: Record<string, string>;
  /** The run's last phase event, such as `reviewer finished`. */
  last: string;
}

export interface StatusRow {
  number: number;
  /** 0 the issue asked for, 1 its children, 2 the PBIs of an Epic's Features. */
  depth: number;
  level: string;
  title: string;
  state: string;
  labels: string[];
  blockedBy: number[];
  pr: StatusPr | null;
  lastRun: LastRun | null;
}

export interface Status {
  repo: string;
  issue: number;
  rows: StatusRow[];
}

export interface PrRef extends StatusPr {
  head: string;
}

/** Everything that touches `gh`; replaced in unit tests. */
export interface StatusOps {
  readIssue: (slug: string, number: number) => Promise<RunnerIssue>;
  issueState: (slug: string, number: number) => Promise<string>;
  listPrs: (slug: string) => Promise<PrRef[]>;
}

async function gh(args: string[]): Promise<string> {
  const res = await execa('gh', args);
  return String(res.stdout);
}

export const defaultStatusOps: StatusOps = {
  readIssue,
  issueState: async (slug, number) =>
    (await gh(['api', `repos/${slug}/issues/${String(number)}`, '--jq', '.state'])).trim(),
  listPrs: async (slug) => {
    const out = await gh([
      'pr',
      'list',
      '-R',
      slug,
      '--state',
      'all',
      '--limit',
      '500',
      '--json',
      'number,url,state,isDraft,headRefName',
    ]);
    let parsed: unknown;
    try {
      parsed = JSON.parse(out);
    } catch {
      throw new Error('gh returned malformed JSON for the pull requests');
    }
    if (!Array.isArray(parsed)) throw new Error('gh returned no list for the pull requests');
    return parsed.map(
      (p: {
        number: number;
        url: string;
        state: string;
        isDraft?: boolean;
        headRefName: string;
      }) => ({
        number: p.number,
        url: p.url,
        state: p.isDraft && p.state === 'OPEN' ? 'draft' : p.state.toLowerCase(),
        head: p.headRefName,
      }),
    );
  },
};

/** `Epic`, `Feature`, `PBI` or `Task` from the `[Level]` title prefix, `issue` without one. */
export function levelOf(title: string): string {
  return /^\[(Epic|Feature|PBI|Task)\]/i.exec(title)?.[1] ?? 'issue';
}

/** The newest PR whose branch is `<type>/<nr>-<slug>` (the runner's and the conventional branch name). */
export function prFor(prs: PrRef[], number: number): StatusPr | null {
  const head = new RegExp(`^[a-z]+/${String(number)}-`);
  const match = prs.filter((p) => head.test(p.head)).sort((a, b) => b.number - a.number)[0];
  return match ? { number: match.number, url: match.url, state: match.state } : null;
}

function phaseEvents(db: Db, issue: number): EventRecord[] {
  const events: EventRecord[] = [];
  let after: number | undefined;
  for (;;) {
    const page = db.queryEvents({ issue, types: PHASE_EVENTS, limit: PAGE, after });
    events.push(...page.events);
    if (page.next === null) return events;
    after = page.next;
  }
}

/** Header of the newest run of `issue` that stored `phase.*` events, `null` without one. */
export function lastRun(db: Db, issue: number): LastRun | null {
  const events = phaseEvents(db, issue).filter((e) => e.runId !== null);
  const runId = events.at(-1)?.runId;
  if (!runId) return null;
  const run = events.filter((e) => e.runId === runId);
  const data = (e: EventRecord) =>
    e.data as { phase?: string; model?: string; harness?: LastRun['harness'] };
  const models: Record<string, string> = {};
  for (const e of run) {
    const d = data(e);
    if (e.kind === 'phase.started' && d.phase && d.model) models[d.phase] = d.model;
  }
  const last = run.at(-1) as EventRecord;
  return {
    runId,
    at: (run[0] as EventRecord).createdAt,
    harness: data(run[0] as EventRecord).harness ?? null,
    models,
    last: `${data(last).phase ?? '?'} ${last.kind.slice('phase.'.length)}`,
  };
}

/** Reads the status of `number` and its children. */
export async function collectStatus(
  slug: string,
  number: number,
  options: { db?: Db; ops?: Partial<StatusOps> } = {},
): Promise<Status> {
  const ops: StatusOps = { ...defaultStatusOps, ...options.ops };
  const [root, rootState, prs] = await Promise.all([
    ops.readIssue(slug, number),
    ops.issueState(slug, number),
    ops.listPrs(slug),
  ]);
  const row = (issue: RunnerIssue, state: string, depth: number): StatusRow => ({
    number: issue.number,
    depth,
    level: levelOf(issue.title),
    title: issue.title,
    state: state.toLowerCase(),
    labels: STATUS_LABELS.filter((l) => issue.labels.includes(l)),
    blockedBy: issue.blockedBy.filter((b) => b.state.toLowerCase() === 'open').map((b) => b.number),
    pr: prFor(prs, issue.number),
    lastRun: options.db ? lastRun(options.db, issue.number) : null,
  });

  const rows = [row(root, rootState, 0)];
  const epic = levelOf(root.title) === 'Epic';
  for (const ref of root.subIssues) {
    const child = await ops.readIssue(slug, ref.number);
    rows.push(row(child, ref.state, 1));
    if (!epic || levelOf(child.title) !== 'Feature') continue;
    for (const grand of child.subIssues) {
      rows.push(row(await ops.readIssue(slug, grand.number), grand.state, 2));
    }
  }
  return { repo: slug, issue: number, rows };
}

function runCell(run: LastRun | null): string {
  if (!run) return '-';
  const models = Object.entries(run.models)
    .map(([phase, model]) => `${phase}=${model}`)
    .join(' ');
  return `${run.runId} ${run.at.slice(0, 16).replace('T', ' ')} ${run.harness?.name ?? '?'} ${models}; ${run.last}`.trim();
}

/** Issue titles are untrusted: no escape sequences or control characters reach the terminal. */
function printable(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]|[\x00-\x1f\x7f-\x9f]/g, '');
}

/** The status as an aligned text table, one row per issue, children indented. */
export function formatStatus(status: Status): string {
  const header = ['issue', 'level', 'state', 'labels', 'blocked by', 'pr', 'last run', 'title'];
  const cells = status.rows.map((r) => [
    `${'  '.repeat(r.depth)}#${String(r.number)}`,
    r.level,
    r.state,
    r.labels.join(',') || '-',
    r.blockedBy.map((b) => `#${String(b)}`).join(',') || '-',
    r.pr ? `#${String(r.pr.number)} ${r.pr.state}` : '-',
    runCell(r.lastRun),
    printable(r.title),
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...cells.map((c) => (c[i] as string).length)),
  );
  const line = (c: string[]) =>
    c
      .map((v, i) => (i === c.length - 1 ? v : v.padEnd(widths[i] as number)))
      .join('  ')
      .trimEnd();
  return `${[line(header), ...cells.map(line)].join('\n')}\n`;
}
