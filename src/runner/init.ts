import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { RUNNER_CONFIG_PATH, RunnerConfigSchema } from './config.js';

export const STACKS = ['ts', 'py', 'dotnet', 'rust', 'ng'] as const;
export type Stack = (typeof STACKS)[number];

/** Default `test.full` per stack; `ts` switches to pnpm when `pnpm-lock.yaml` exists. */
const STACK_TEST: Record<Stack, string> = {
  ts: 'npm test',
  py: 'pytest',
  dotnet: 'dotnet test',
  rust: 'cargo test',
  ng: 'npx ng test --watch=false --browsers=ChromeHeadless',
};

/** Stack by marker files in the repository root; `undefined` when none matches. */
export function detectStack(repoDir: string): Stack | undefined {
  const has = (name: string) => existsSync(join(repoDir, name));
  if (has('angular.json')) return 'ng';
  if (has('Cargo.toml')) return 'rust';
  if (readdirSync(repoDir).some((f) => f.endsWith('.csproj'))) return 'dotnet';
  if (has('pyproject.toml')) return 'py';
  if (has('package.json') || has('pnpm-lock.yaml')) return 'ts';
  return undefined;
}

export function stackTestCommand(repoDir: string, stack: Stack): string {
  if (stack === 'ts' && existsSync(join(repoDir, 'pnpm-lock.yaml'))) return 'pnpm test';
  return STACK_TEST[stack];
}

export interface InitOptions {
  repoDir: string;
  stack?: Stack | undefined;
  testFull?: string | undefined;
}

export interface ConfigIssue {
  path: string;
  message: string;
}

export type InitResult =
  | {
      ok: true;
      path: string;
      action: 'created' | 'updated' | 'unchanged';
      added: string[];
      kept: string[];
      before: string;
      after: string;
    }
  | { ok: false; path: string; errors: ConfigIssue[] };

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The keys `init` manages, with defaults taken from the schema (`test.full` from the stack). */
function managedDefaults(opts: InitOptions): [string, unknown][] {
  const defaults = RunnerConfigSchema.parse({});
  const stack = opts.stack ?? detectStack(opts.repoDir);
  const testFull =
    opts.testFull ?? (stack ? stackTestCommand(opts.repoDir, stack) : defaults.test.full);
  return [
    ['harness', defaults.harness],
    ['test.full', testFull],
    ['parallel', defaults.parallel],
  ];
}

function hasPath(obj: Json, path: string): boolean {
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (!isObject(cur) || !(part in cur)) return false;
    cur = cur[part];
  }
  return true;
}

function setPath(obj: Json, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur = obj;
  for (const part of parts.slice(0, -1)) {
    const next = cur[part];
    if (isObject(next)) {
      cur = next;
    } else {
      const created: Json = {};
      cur[part] = created;
      cur = created;
    }
  }
  cur[parts[parts.length - 1] as string] = value;
}

export function issuesOf(error: {
  issues: { path: PropertyKey[]; message: string }[];
}): ConfigIssue[] {
  return error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }));
}

/** Computes the file `init` would write; touches nothing. An invalid existing file yields errors. */
export function planInit(opts: InitOptions): InitResult {
  const path = join(opts.repoDir, RUNNER_CONFIG_PATH);
  const exists = existsSync(path);
  const before = exists ? readFileSync(path, 'utf8') : '';
  let current: Json = {};
  if (exists) {
    let raw: unknown;
    try {
      raw = JSON.parse(before);
    } catch (error) {
      const message = `invalid JSON: ${error instanceof Error ? error.message : String(error)}`;
      return { ok: false, path, errors: [{ path: '', message }] };
    }
    const parsed = RunnerConfigSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, path, errors: issuesOf(parsed.error) };
    current = raw as Json;
  }
  const added: string[] = [];
  const kept: string[] = [];
  for (const [key, value] of managedDefaults(opts)) {
    if (hasPath(current, key)) {
      kept.push(key);
    } else {
      setPath(current, key, value);
      added.push(key);
    }
  }
  const after = `${JSON.stringify(current, null, 2)}\n`;
  const action = !exists ? 'created' : added.length > 0 ? 'updated' : 'unchanged';
  return { ok: true, path, action, added, kept, before, after };
}

/** Writes the planned file. */
export function applyInit(result: Extract<InitResult, { ok: true }>): void {
  if (result.action === 'unchanged') return;
  mkdirSync(dirname(result.path), { recursive: true });
  writeFileSync(result.path, result.after);
}

/** Line diff of two texts: lines only in `before` as `-`, only in `after` as `+`. */
export function lineDiff(before: string, after: string): string {
  const a = before === '' ? [] : before.replace(/\n$/, '').split('\n');
  const b = after.replace(/\n$/, '').split('\n');
  const inA = new Set(a);
  const inB = new Set(b);
  return [
    ...a.filter((l) => !inB.has(l)).map((l) => `- ${l}`),
    ...b.filter((l) => !inA.has(l)).map((l) => `+ ${l}`),
  ].join('\n');
}
