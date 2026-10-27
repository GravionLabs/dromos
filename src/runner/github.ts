import { execa } from 'execa';
import { type IssueInfo, viewIssue } from '../github.js';

/**
 * Every `gh` call of the runner goes through here. Phases never call `gh` (the allowlist in
 * `permissions.ts` denies it); the runner does, between phases.
 */

export const CLAIM_LABEL = 'in-progress';

export interface IssueRef {
  number: number;
  title: string;
  state: string;
}

export interface RunnerIssue extends IssueInfo {
  subIssues: IssueRef[];
  blockedBy: IssueRef[];
}

export interface PullRequest {
  number: number;
  url: string;
}

export class ClaimError extends Error {}

async function gh(args: string[], cwd?: string): Promise<string> {
  const res = await execa('gh', args, cwd ? { cwd } : undefined);
  return String(res.stdout);
}

function parseRefs(stdout: string, what: string): IssueRef[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`gh returned malformed JSON for ${what}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`gh returned no list for ${what}`);
  return parsed.map((r: { number: number; title?: string; state?: string }) => ({
    number: r.number,
    title: r.title ?? '',
    state: r.state ?? '',
  }));
}

/** The issue with its Task sub-issues and the issues it is blocked by. */
export async function readIssue(repo: string, number: number): Promise<RunnerIssue> {
  const [issue, subs, blockers] = await Promise.all([
    viewIssue(repo, number),
    gh(['api', `repos/${repo}/issues/${String(number)}/sub_issues`]),
    gh(['api', `repos/${repo}/issues/${String(number)}/dependencies/blocked_by`]),
  ]);
  return {
    ...issue,
    subIssues: parseRefs(subs, `sub-issues of #${String(number)}`),
    blockedBy: parseRefs(blockers, `blockers of #${String(number)}`),
  };
}

export async function addLabel(repo: string, number: number, label: string): Promise<void> {
  await gh(['issue', 'edit', String(number), '-R', repo, '--add-label', label]);
}

export async function removeLabel(repo: string, number: number, label: string): Promise<void> {
  await gh(['issue', 'edit', String(number), '-R', repo, '--remove-label', label]);
}

export async function comment(repo: string, number: number, body: string): Promise<void> {
  await gh(['issue', 'comment', String(number), '-R', repo, '--body', body]);
}

/** Marks the PBI as taken by this run; a PBI that already carries the label is refused unless `force`. */
export async function claimIssue(
  repo: string,
  number: number,
  runId: string,
  force = false,
): Promise<void> {
  const issue = await viewIssue(repo, number);
  if (issue.labels.includes(CLAIM_LABEL) && !force) {
    throw new ClaimError(
      `#${String(number)} already carries '${CLAIM_LABEL}' (another run?); use --force to take it over`,
    );
  }
  await addLabel(repo, number, CLAIM_LABEL);
  await comment(repo, number, `dromos run \`${runId}\` claimed this PBI.`);
}

/** Removes the claim on `pr_opened` and `blocked`. */
export async function releaseIssue(repo: string, number: number): Promise<void> {
  await removeLabel(repo, number, CLAIM_LABEL);
}

export interface CreatePrInput {
  base: string;
  head: string;
  title: string;
  body: string;
  draft?: boolean;
}

function parsePrUrl(stdout: string): PullRequest {
  const url = stdout.trim().split(/\s+/).pop() ?? '';
  const m = /^https:\/\/\S+\/pull\/(\d+)$/.exec(url);
  if (!m) throw new Error('gh pr create printed no https PR url');
  return { number: Number(m[1]), url };
}

export async function createPr(repo: string, input: CreatePrInput): Promise<PullRequest> {
  const args = [
    'pr',
    'create',
    '-R',
    repo,
    '--base',
    input.base,
    '--head',
    input.head,
    '--title',
    input.title,
    '--body',
    input.body,
  ];
  if (input.draft) args.push('--draft');
  return parsePrUrl(await gh(args));
}

/** `gh pr edit` needs `read:org`; the REST endpoint does not. */
export async function updatePr(
  repo: string,
  pr: number,
  fields: { title?: string; body?: string },
): Promise<void> {
  const args = ['api', '-X', 'PATCH', `repos/${repo}/pulls/${String(pr)}`];
  if (fields.title !== undefined) args.push('-f', `title=${fields.title}`);
  if (fields.body !== undefined) args.push('-f', `body=${fields.body}`);
  await gh(args);
}

/** Turns a draft PR into a ready one. */
export async function markReady(repo: string, pr: number): Promise<void> {
  await gh(['pr', 'ready', String(pr), '-R', repo]);
}
