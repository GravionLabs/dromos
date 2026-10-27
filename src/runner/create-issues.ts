import { execa } from 'execa';
import type { Plan, PlanParent } from './plan.js';
import { validatePlan } from './plan.js';

/**
 * The runner, not the LLM, creates the issues of a plan: PBIs under a Feature, Tasks under a PBI,
 * each with a `[Level]` title prefix, `Parent <Level>: #N` as first body line, a native sub-issue
 * link, blocked-by links from `dependsOn` and the label `needs-approval`.
 */

export const APPROVAL_LABEL = 'needs-approval';

export interface CreatedIssue {
  /** The plan item id. */
  id: string;
  number: number;
}

async function gh(args: string[]): Promise<string> {
  const res = await execa('gh', args);
  return String(res.stdout);
}

function issueNumber(stdout: string): number {
  const m = /\/issues\/(\d+)\s*$/.exec(stdout.trim());
  if (!m) throw new Error('gh issue create printed no issue url');
  return Number(m[1]);
}

/** The REST id of an issue; the sub-issue and dependency endpoints take it, not the number. */
async function restId(repo: string, number: number): Promise<number> {
  const id = Number(
    (await gh(['api', `repos/${repo}/issues/${String(number)}`, '--jq', '.id'])).trim(),
  );
  if (!Number.isInteger(id)) throw new Error(`gh returned no id for #${String(number)}`);
  return id;
}

/** Creates the plan's items as issues, links them to the parent and to each other. */
export async function createIssues(
  repo: string,
  parent: PlanParent,
  plan: Plan,
): Promise<CreatedIssue[]> {
  validatePlan(plan);
  const level = parent.level === 'Feature' ? 'PBI' : 'Task';
  const numbers = new Map<string, number>();
  const created: CreatedIssue[] = [];

  for (const item of plan.items) {
    const body = `Parent ${parent.level}: #${String(parent.number)}\n\n${item.body}`;
    const number = issueNumber(
      await gh([
        'issue',
        'create',
        '-R',
        repo,
        '--title',
        `[${level}] ${item.title}`,
        '--body',
        body,
        '--label',
        APPROVAL_LABEL,
      ]),
    );
    numbers.set(item.id, number);
    created.push({ id: item.id, number });
    await gh([
      'api',
      '-X',
      'POST',
      `repos/${repo}/issues/${String(parent.number)}/sub_issues`,
      '-F',
      `sub_issue_id=${String(await restId(repo, number))}`,
    ]);
  }

  for (const item of plan.items) {
    const number = numbers.get(item.id) as number;
    for (const dep of item.dependsOn) {
      await gh([
        'api',
        '-X',
        'POST',
        `repos/${repo}/issues/${String(number)}/dependencies/blocked_by`,
        '-F',
        `issue_id=${String(await restId(repo, numbers.get(dep) as number))}`,
      ]);
    }
  }
  return created;
}
