import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RunnerConfigSchema } from './config.js';
import type { Harness } from './harness.js';
import {
  PLAN_SCHEMA_PATH,
  type Plan,
  type PlannerDeps,
  PlanSchema,
  runPlannerPhase,
  serializePlanSchema,
  validatePlan,
} from './plan.js';

const plan: Plan = {
  items: [
    { id: 'a', title: 'A', body: 'body a', size: 'S', dependsOn: [] },
    { id: 'b', title: 'B', body: 'body b', dependsOn: ['a'] },
  ],
  questions: [
    { id: 'q1', question: 'Which?', options: ['x', 'y'], recommended: 'x', why: 'simpler' },
  ],
  assumptions: ['no migration'],
};

const parent = { level: 'Feature', number: 210, title: 'F', body: 'feature body' } as const;

function deps(harness: Harness, events: unknown[] = []): PlannerDeps {
  return {
    harness,
    harnessInfo: { id: 'claude', name: 'claude', version: null, sdk: null },
    config: RunnerConfigSchema.parse({}),
    cwd: '/tmp/wt',
    skillDirs: ['planner'],
    allow: () => ({ allow: true }),
    timeoutMs: 1000,
    emit: (e) => events.push(e),
  };
}

const replying = (result: unknown): Harness => ({
  async runPhase() {
    return { result, events: [], usage: null };
  },
});

describe('plan.schema.json', () => {
  it('is in sync with PlanSchema (run `tsx src/runner/plan.ts` to regenerate)', () => {
    expect(readFileSync(PLAN_SCHEMA_PATH, 'utf8')).toBe(serializePlanSchema());
  });
});

describe('PlanSchema', () => {
  it('accepts items, questions and assumptions', () => {
    expect(PlanSchema.parse(plan)).toEqual(plan);
  });

  it('rejects a question without a recommendation', () => {
    const bad = { ...plan, questions: [{ id: 'q', question: 'Q', options: [], why: '' }] };
    expect(PlanSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects unknown keys', () => {
    expect(PlanSchema.safeParse({ ...plan, extra: 1 }).success).toBe(false);
  });
});

describe('validatePlan', () => {
  it('accepts an empty plan', () => {
    expect(() => validatePlan({ items: [], questions: [], assumptions: [] })).not.toThrow();
  });

  it('rejects duplicate ids, unknown and self dependencies and cycles', () => {
    const item = (id: string, dependsOn: string[]) => ({ id, title: id, body: '', dependsOn });
    const of = (...items: ReturnType<typeof item>[]) => ({ ...plan, items });
    expect(() => validatePlan(of(item('a', []), item('a', [])))).toThrow(/duplicate/);
    expect(() => validatePlan(of(item('a', ['z'])))).toThrow(/unknown item 'z'/);
    expect(() => validatePlan(of(item('a', ['a'])))).toThrow(/itself/);
    expect(() => validatePlan(of(item('a', ['b']), item('b', ['a'])))).toThrow(/block each other/);
  });
});

describe('runPlannerPhase', () => {
  it('returns the validated plan and brackets the phase with events', async () => {
    const events: { type: string }[] = [];
    const out = await runPlannerPhase(deps(replying(plan), events), parent);
    expect(out.plan).toEqual(plan);
    expect(events.map((e) => e.type)).toEqual(['phase.started', 'phase.finished']);
  });

  it('asks for PBIs under a Feature and Tasks under a PBI, with the planner skill', async () => {
    const prompts: string[] = [];
    const harness: Harness = {
      async runPhase(input) {
        prompts.push(input.prompt);
        expect(input.model).toBe('opus');
        expect(input.skills).toEqual(['planner']);
        return { result: plan, events: [], usage: null };
      },
    };
    await runPlannerPhase(deps(harness), parent);
    await runPlannerPhase(deps(harness), { ...parent, level: 'PBI', number: 5 });
    expect(prompts[0]).toContain('Split it into PBIs');
    expect(prompts[1]).toContain('Plan PBI #5');
    expect(prompts[1]).toContain('Split it into Tasks');
  });

  it('fails on a reply that does not match the schema', async () => {
    const events: { type: string }[] = [];
    await expect(runPlannerPhase(deps(replying({ items: 1 }), events), parent)).rejects.toThrow();
    expect(events.map((e) => e.type)).toEqual(['phase.started', 'phase.failed']);
  });

  it('fails on a plan with an unknown dependency', async () => {
    const bad = { ...plan, items: [{ id: 'a', title: 'A', body: '', dependsOn: ['nope'] }] };
    await expect(runPlannerPhase(deps(replying(bad)), parent)).rejects.toThrow(/unknown item/);
  });
});
