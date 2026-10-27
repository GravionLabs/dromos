import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { z } from 'zod';
import type { Harness, PhaseInput, Usage } from './harness.js';

/**
 * Planner phase: one harness session with the `planner` skill plans an issue one level down and
 * returns `{items, questions, assumptions}` as data. The runner, not the LLM, creates the issues
 * from it (the allowlist denies `gh` in phases).
 */

export const NEEDS_APPROVAL_LABEL = 'needs-approval';

/** Level of the issues a plan creates: PBIs under a Feature, Tasks under a PBI. */
export type PlanLevel = 'PBI' | 'Task';

export const PlanItemSchema = z.strictObject({
  /** Local key, referenced by `dependsOn`; unique inside one plan. */
  key: z.string().min(1),
  title: z.string().min(1),
  body: z.string().min(1),
  size: z.enum(['XS', 'S', 'M', 'L', 'XL']).optional(),
  /** Keys of other items of this plan that block this one. */
  dependsOn: z.array(z.string().min(1)),
});

export const PlanQuestionSchema = z.strictObject({
  id: z.string().min(1),
  question: z.string().min(1),
  options: z.array(z.string().min(1)),
  recommended: z.string().min(1),
  why: z.string().min(1),
});

export const PlanSchema = z.strictObject({
  items: z.array(PlanItemSchema),
  questions: z.array(PlanQuestionSchema),
  assumptions: z.array(z.string().min(1)),
});
export type Plan = z.infer<typeof PlanSchema>;
export type PlanItem = z.infer<typeof PlanItemSchema>;

export const PLAN_SCHEMA_PATH = fileURLToPath(
  new URL('../../schema/plan.schema.json', import.meta.url),
);

export function serializePlanSchema(): string {
  return `${JSON.stringify(z.toJSONSchema(PlanSchema, { target: 'draft-7', io: 'output' }), null, 2)}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(PLAN_SCHEMA_PATH, serializePlanSchema());
}

export function readPlanSchemaFile(): string {
  return readFileSync(PLAN_SCHEMA_PATH, 'utf8');
}

/** Rejects duplicate keys, unknown or self references and cycles in `dependsOn`. */
export function validatePlan(plan: Plan): void {
  const keys = new Set<string>();
  for (const item of plan.items) {
    if (keys.has(item.key)) throw new Error(`plan has duplicate item key '${item.key}'`);
    keys.add(item.key);
  }
  for (const item of plan.items) {
    for (const dep of item.dependsOn) {
      if (!keys.has(dep)) throw new Error(`item '${item.key}' depends on unknown key '${dep}'`);
      if (dep === item.key) throw new Error(`item '${item.key}' depends on itself`);
    }
  }
  const done = new Set<string>();
  let rest = plan.items;
  while (rest.length > 0) {
    const ready = rest.filter((i) => i.dependsOn.every((d) => done.has(d)));
    if (ready.length === 0) {
      throw new Error(`plan items block each other: ${rest.map((i) => i.key).join(', ')}`);
    }
    for (const i of ready) done.add(i.key);
    rest = rest.filter((i) => !done.has(i.key));
  }
}

export interface PlannerInput {
  harness: Harness;
  cwd: string;
  model: string;
  skills: string[];
  allow: PhaseInput['allow'];
  timeoutMs: number;
  /** The issue to plan one level down. */
  issue: { number: number; title: string; body: string };
  level: PlanLevel;
}

export interface PlannerOutput {
  plan: Plan;
  usage: Usage | null;
}

function plannerPrompt(input: PlannerInput): string {
  const parent = input.level === 'PBI' ? 'Feature' : 'PBI';
  return [
    `Plan ${parent} #${String(input.issue.number)}: ${input.issue.title} into ${input.level}s.`,
    '## Issue',
    input.issue.body,
    'Use the `planner` skill. Do not create issues and do not call `gh`; the runner creates them ' +
      'from your answer. Put every open decision into `questions` (with options, a recommendation ' +
      'and why) and every assumption you made into `assumptions`.',
  ].join('\n\n');
}

/** Runs the planner session and validates its answer; a malformed plan throws. */
export async function runPlannerPhase(input: PlannerInput): Promise<PlannerOutput> {
  const out = await input.harness.runPhase({
    prompt: plannerPrompt(input),
    cwd: input.cwd,
    model: input.model,
    skills: input.skills,
    allow: input.allow,
    schema: PlanSchema,
    timeoutMs: input.timeoutMs,
  });
  const plan = PlanSchema.parse(out.result);
  validatePlan(plan);
  return { plan, usage: out.usage };
}

export interface CreatedIssue {
  key: string;
  number: number;
  url: string;
}

async function gh(args: string[]): Promise<string> {
  const res = await execa('gh', args);
  return String(res.stdout);
}

function parseIssueUrl(stdout: string): { number: number; url: string } {
  const url = stdout.trim().split(/\s+/).pop() ?? '';
  const m = /^https:\/\/\S+\/issues\/(\d+)$/.exec(url);
  if (!m) throw new Error('gh issue create printed no https issue url');
  return { number: Number(m[1]), url };
}

async function databaseId(repo: string, number: number): Promise<string> {
  const id = (await gh(['api', `repos/${repo}/issues/${String(number)}`, '--jq', '.id'])).trim();
  if (!/^\d+$/.test(id)) throw new Error(`gh returned no id for #${String(number)}`);
  return id;
}

/** `Parent Feature: #N` as the first body line, then the item body. */
export function issueBody(level: PlanLevel, parent: number, item: PlanItem): string {
  const parentLevel = level === 'PBI' ? 'Feature' : 'PBI';
  return `Parent ${parentLevel}: #${String(parent)}\n\n${item.body}`;
}

/**
 * Creates one issue per plan item under `parent`: `[Level]` title prefix, `Parent …: #N` first body
 * line, label `needs-approval`, native sub-issue link, then blocked-by links from `dependsOn`.
 * Returns the created issues in plan order.
 */
export async function createPlanIssues(
  repo: string,
  parent: number,
  level: PlanLevel,
  plan: Plan,
): Promise<CreatedIssue[]> {
  validatePlan(plan);
  const created = new Map<string, CreatedIssue & { id: string }>();
  for (const item of plan.items) {
    const out = await gh([
      'issue',
      'create',
      '-R',
      repo,
      '--title',
      `[${level}] ${item.title}`,
      '--body',
      issueBody(level, parent, item),
      '--label',
      NEEDS_APPROVAL_LABEL,
    ]);
    const { number, url } = parseIssueUrl(out);
    const id = await databaseId(repo, number);
    await gh([
      'api',
      '-X',
      'POST',
      `repos/${repo}/issues/${String(parent)}/sub_issues`,
      '-F',
      `sub_issue_id=${id}`,
    ]);
    created.set(item.key, { key: item.key, number, url, id });
  }
  for (const item of plan.items) {
    const me = created.get(item.key);
    if (!me) continue;
    for (const dep of item.dependsOn) {
      const blocker = created.get(dep);
      if (!blocker) continue;
      await gh([
        'api',
        '-X',
        'POST',
        `repos/${repo}/issues/${String(me.number)}/dependencies/blocked_by`,
        '-F',
        `issue_id=${blocker.id}`,
      ]);
    }
  }
  return plan.items.flatMap((i) => {
    const c = created.get(i.key);
    return c ? [{ key: c.key, number: c.number, url: c.url }] : [];
  });
}
