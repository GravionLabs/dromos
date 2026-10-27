import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { modelFor } from './config.js';
import type { Usage } from './harness.js';
import type { ImplementerDeps } from './implementer.js';

/**
 * Planner phase: one planner session reads a Feature or a PBI and returns its children as data
 * (`items`), open `questions` and `assumptions`. The session never creates issues; the runner does
 * (`create-issues.ts`). Until apm-hub ships `plan.schema.json`, the shape here follows plan section 3.5.
 */

export const PlanItemSchema = z.strictObject({
  /** Local id, referenced by `dependsOn` of other items. */
  id: z.string().min(1),
  title: z.string().min(1),
  body: z.string(),
  size: z.enum(['XS', 'S', 'M', 'L', 'XL']).optional(),
  /** Ids of items of the same plan this one is blocked by. */
  dependsOn: z.array(z.string().min(1)),
});
export type PlanItem = z.infer<typeof PlanItemSchema>;

export const PlanQuestionSchema = z.strictObject({
  id: z.string().min(1),
  question: z.string().min(1),
  options: z.array(z.string().min(1)),
  recommended: z.string().min(1),
  why: z.string(),
});
export type PlanQuestion = z.infer<typeof PlanQuestionSchema>;

export const PlanSchema = z.strictObject({
  items: z.array(PlanItemSchema),
  questions: z.array(PlanQuestionSchema),
  assumptions: z.array(z.string()),
});
export type Plan = z.infer<typeof PlanSchema>;

export const PLAN_SCHEMA_PATH = fileURLToPath(
  new URL('../../schema/plan.schema.json', import.meta.url),
);

export function serializePlanSchema(): string {
  return `${JSON.stringify(z.toJSONSchema(PlanSchema, { target: 'draft-7', io: 'output' }), null, 2)}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(PLAN_SCHEMA_PATH, serializePlanSchema());
}

/** Level of the planned issue; its children are one level down. */
export type ParentLevel = 'Feature' | 'PBI';

export interface PlanParent {
  level: ParentLevel;
  number: number;
  title: string;
  body: string;
}

/** Ids are unique, every `dependsOn` names another item of the plan, and the dependencies have no cycle. */
export function validatePlan(plan: Plan): void {
  const ids = new Set<string>();
  for (const item of plan.items) {
    if (ids.has(item.id)) throw new Error(`duplicate plan item id '${item.id}'`);
    ids.add(item.id);
  }
  for (const item of plan.items) {
    for (const dep of item.dependsOn) {
      if (dep === item.id) throw new Error(`item '${item.id}' depends on itself`);
      if (!ids.has(dep)) throw new Error(`item '${item.id}' depends on unknown item '${dep}'`);
    }
  }
  const done = new Set<string>();
  let rest = plan.items;
  while (rest.length > 0) {
    const ready = rest.filter((i) => i.dependsOn.every((d) => done.has(d)));
    if (ready.length === 0) {
      throw new Error(`plan items block each other: ${rest.map((i) => i.id).join(', ')}`);
    }
    for (const i of ready) done.add(i.id);
    rest = rest.filter((i) => !done.has(i.id));
  }
}

function plannerPrompt(parent: PlanParent): string {
  const child = parent.level === 'Feature' ? 'PBIs' : 'Tasks';
  return [
    `Plan ${parent.level} #${String(parent.number)}: ${parent.title}`,
    parent.body,
    `Use the \`planner\` skill. Split it into ${child}. Do not create issues and do not change files; ` +
      'the runner creates them from your reply.',
    'Reply with `items` (id, title, body, size, dependsOn with item ids), `questions` (id, question, ' +
      'options, recommended, why) for decisions a human must make, and `assumptions`.',
  ].join('\n\n');
}

export type PlannerDeps = Pick<
  ImplementerDeps,
  | 'harness'
  | 'harnessInfo'
  | 'config'
  | 'cwd'
  | 'skillDirs'
  | 'allow'
  | 'timeoutMs'
  | 'emit'
  | 'now'
>;

export interface PlannerOutcome {
  plan: Plan;
  usage: Usage | null;
}

/** Runs one planner session; a reply that does not match the plan schema throws. */
export async function runPlannerPhase(
  deps: PlannerDeps,
  parent: PlanParent,
): Promise<PlannerOutcome> {
  const { config, harnessInfo, emit } = deps;
  const now = deps.now ?? Date.now;
  const model = modelFor(config, harnessInfo.id, 'planner');
  const base = { phase: `planner #${String(parent.number)}`, harness: harnessInfo, model };
  emit({ type: 'phase.started', data: base });
  const start = now();
  const end = (usage: Usage | null) => ({ ...base, durationMs: now() - start, usage });
  try {
    const out = await deps.harness.runPhase({
      prompt: plannerPrompt(parent),
      cwd: deps.cwd,
      model,
      skills: deps.skillDirs,
      allow: deps.allow,
      schema: PlanSchema,
      timeoutMs: deps.timeoutMs,
    });
    const plan = PlanSchema.parse(out.result);
    validatePlan(plan);
    emit({ type: 'phase.finished', data: end(out.usage) });
    return { plan, usage: out.usage };
  } catch (error) {
    emit({ type: 'phase.failed', data: end(null) });
    throw error;
  }
}
