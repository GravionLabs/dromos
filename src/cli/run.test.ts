import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BusEvents } from '../bus-events.js';
import { type Db, openDb } from '../db.js';
import { recordEvent } from '../event-store.js';
import { EVENTS_SCHEMA_PATH } from '../events/export-schema.js';
import { BusEventSchema } from '../events/schema.js';
import { runRunCli } from './run.js';

interface JsonSchemaNode {
  properties?: Record<string, { const?: unknown }>;
  required?: string[];
  additionalProperties?: boolean;
}
const busEventSchema = JSON.parse(readFileSync(EVENTS_SCHEMA_PATH, 'utf8')) as {
  definitions: Record<string, JsonSchemaNode & { anyOf?: unknown[] }>;
};

/** Checks the event against its variant in schema/events.schema.json: required keys, no extra keys. */
function expectMatchesJsonSchema(e: Record<string, unknown>) {
  const variant = Object.values(busEventSchema.definitions).find(
    (d) => d.properties?.type?.const === e.type,
  );
  expect(variant, `variant for ${String(e.type)}`).toBeDefined();
  const props = Object.keys(variant?.properties ?? {});
  expect(Object.keys(e).sort()).toEqual([...props].sort());
  for (const key of variant?.required ?? []) expect(e).toHaveProperty(key);
}

let db: Db;
beforeEach(() => {
  db = openDb(':memory:');
});
afterEach(() => db.close());

const bus = new BusEvents();
const base = { at: '2026-10-23T08:12:00.000Z', id: 0, runId: null };
const run = (state: string, runAgentId: string, parent: string | null, depth: number, issue = 7) =>
  recordEvent(db, bus, 'apm-hub/subagent', {
    ...base,
    type: 'agent.run',
    source: 'apm-hub/subagent',
    agentId: 'pane-1',
    issue,
    data: {
      state,
      runAgentId,
      parentAgentId: parent,
      toolUseId: null,
      agentType: 'implementer',
      description: 'SECRET-DESCRIPTION',
      depth,
      model: null,
      durationMs: state === 'stopped' ? 2000 : null,
      summary: 'SECRET-SUMMARY',
    },
  });

function seed() {
  run('started', 'r1', null, 1);
  run('started', 'r2', 'r1', 2);
  recordEvent(db, bus, 'apm-hub/queue', {
    ...base,
    type: 'attention',
    source: 'apm-hub/queue',
    agentId: 'pane-1',
    issue: 7,
    data: { kind: 'QUESTION', summary: 'SECRET-SUMMARY', pr: 12, question: 'SECRET-QUESTION' },
  });
  recordEvent(db, bus, 'apm-hub/progress', {
    ...base,
    type: 'progress',
    source: 'apm-hub/progress',
    agentId: 'pane-1',
    issue: 7,
    data: { line: 'SECRET-PROGRESS', agent: 'impl', kind: 'task' },
  });
  run('stopped', 'r2', 'r1', 2);
  run('started', 'other', null, 1, 8);
}

async function cli(argv: string[], files: Map<string, string> = new Map()) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runRunCli(argv, {
    db,
    now: () => new Date('2026-10-26T10:00:00.000Z'),
    out: (t) => out.push(t),
    err: (l) => err.push(l),
    writeFile: (p, t) => files.set(p, t),
  });
  return { code, out: out.join(''), err };
}

describe('dromos run export --format json', () => {
  it('wraps the issue events in id order with exactly four keys', async () => {
    seed();
    const r = await cli(['export', '7']);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.out);
    expect(Object.keys(doc).sort()).toEqual(['events', 'exportedAt', 'issue', 'schema']);
    expect(doc.schema).toBe(1);
    expect(doc.issue).toBe(7);
    expect(doc.exportedAt).toBe('2026-10-26T10:00:00.000Z');
    const ids = doc.events.map((e: { id: number }) => e.id);
    expect(ids).toHaveLength(5);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    for (const e of doc.events) {
      expect(BusEventSchema.parse(e)).toBeDefined();
      expectMatchesJsonSchema(e);
    }
  });

  it('is the default format', async () => {
    seed();
    expect(JSON.parse((await cli(['export', '7'])).out).issue).toBe(7);
  });

  it('pages past the 1000 row limit', async () => {
    for (let i = 0; i < 1005; i++) run('started', `r${i}`, null, 1);
    expect(JSON.parse((await cli(['export', '7'])).out).events).toHaveLength(1005);
  });
});

describe('dromos run export --format mermaid', () => {
  it('prints a tree with the attention node and no free text', async () => {
    seed();
    const r = await cli(['export', '7', '--format', 'mermaid']);
    expect(r.code).toBe(0);
    expect(r.out.startsWith('flowchart TD\n')).toBe(true);
    expect(r.out).toContain('pane0_pane1 --> run1_r1');
    expect(r.out).toContain('run1_r1 --> run2_r2');
    expect(r.out).toContain('{{"QUESTION #12"}}');
    expect(r.out).toContain('implementer 2s');
    expect(r.out).toContain('implementer running');
    expect(r.out).not.toMatch(/SECRET/);
    expect(r.out).not.toContain('other');
  });

  it('keeps labels parser safe', async () => {
    recordEvent(db, bus, 'apm-hub/queue', {
      ...base,
      type: 'attention',
      source: 'apm-hub/queue',
      agentId: 'pa"ne[1]',
      issue: 7,
      data: { kind: 'GA"TE]', summary: 's', pr: null },
    });
    const out = (await cli(['export', '7', '--format', 'mermaid'])).out;
    expect(out).toContain('pane0_pane1["pane1"]');
    expect(out).toContain('{{"GATE"}}');
  });
});

describe('dromos run export errors', () => {
  it('exits 1 with no output and no file for an unknown issue', async () => {
    seed();
    const files = new Map<string, string>();
    const r = await cli(['export', '99', '--out', 'x.json'], files);
    expect(r).toEqual({ code: 1, out: '', err: [] });
    expect(files.size).toBe(0);
  });

  it('writes --out instead of stdout', async () => {
    seed();
    const files = new Map<string, string>();
    const r = await cli(['export', '7', '--out', 'x.json'], files);
    expect(r.code).toBe(0);
    expect(r.out).toBe('');
    expect(JSON.parse(files.get('x.json') as string).issue).toBe(7);
  });

  it('writes a real file by default', async () => {
    seed();
    const dir = mkdtempSync(join(tmpdir(), 'dromos-run-'));
    try {
      const file = join(dir, 'out.mmd');
      const code = await runRunCli(['export', '7', '--format', 'mermaid', '--out', file], { db });
      expect(code).toBe(0);
      expect(existsSync(file)).toBe(true);
      expect(readFileSync(file, 'utf8')).toMatch(/^flowchart TD/);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    [['export', '7', '--format', 'dagr']],
    [['export']],
    [['export', 'abc']],
    [['export', '7', '--bogus', 'x']],
    [['export', '7', '--out']],
    [['stats', '7']],
    [[]],
  ])('gives a usage error for %j', async (argv) => {
    const r = await cli(argv);
    expect(r.code).toBe(2);
    expect(r.out).toBe('');
    expect(r.err[0]).toContain('usage: dromos run export');
  });
});

describe('src/cli.ts run dispatch', () => {
  const index = fileURLToPath(new URL('../cli.ts', import.meta.url));

  it('reads bus.db from the configured dataDir and prints the export', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dromos-run-idx-'));
    try {
      mkdirSync(join(dir, 'data'));
      writeFileSync(join(dir, 'dromos.config.json'), JSON.stringify({ dataDir: 'data' }));
      const store = openDb(join(dir, 'data', 'bus.db'));
      store.insertEvent(
        'apm-hub/subagent',
        'attention',
        { kind: 'GATE', summary: 's', pr: null },
        {
          agentId: 'p',
          issue: 7,
        },
      );
      store.close();
      const r = spawnSync(process.execPath, ['--import', 'tsx', index, 'run', 'export', '7'], {
        encoding: 'utf8',
        env: { ...process.env, DROMOS_CONFIG: join(dir, 'dromos.config.json') },
      });
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout).events).toHaveLength(1);
      expect(r.stderr).not.toContain('listening');
      const missing = spawnSync(
        process.execPath,
        ['--import', 'tsx', index, 'run', 'export', '8'],
        {
          encoding: 'utf8',
          env: { ...process.env, DROMOS_CONFIG: join(dir, 'dromos.config.json') },
        },
      );
      expect(missing.status).toBe(1);
      expect(missing.stdout).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('dromos run task usage', () => {
  const run = async (args: string[]) => {
    const lines: string[] = [];
    const code = await runRunCli(args, { db, err: (l) => lines.push(l) });
    return { code, text: lines.join('\n') };
  };

  it.each([
    [['task'], /task needs <issue>/],
    [['task', 'x', '--harness', 'claude'], /positive integer/],
    [['task', '5'], /--harness must be claude, claude-cli or copilot/],
    [['task', '5', '--harness', 'gemini'], /--harness must be claude, claude-cli or copilot/],
    [['task', '5', '--harness', 'claude', '--nope', 'x'], /unknown option/],
  ])('rejects %j with exit code 2', async (args, message) => {
    const res = await run(args);
    expect(res.code).toBe(2);
    expect(res.text).toMatch(message);
    expect(res.text).toContain('dromos run task <issue>');
  });
});

describe('dromos run pbi', () => {
  const pbiIssue = {
    number: 5,
    title: '[PBI] feat: thing',
    body: '## Acceptance Criteria\n\n- [ ] a',
    labels: [],
    subIssues: [],
    blockedBy: [],
  };
  const ops = {
    repoSlug: async () => 'o/r',
    readIssue: async () => pbiIssue,
  };
  const repo = mkdtempSync(join(tmpdir(), 'dromos-run-pbi-'));
  const run = async (args: string[], isTty: boolean) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runRunCli(['pbi', '5', '--repo', repo, ...args], {
      db,
      out: (t) => stdout.push(t),
      err: (l) => stderr.push(l),
      pbi: { ops, isTty },
    });
    return { code, stdout: stdout.join(''), stderr: stderr.join('\n') };
  };

  it.each([
    [['pbi'], /pbi needs <nr>/],
    [['pbi', 'x'], /positive integer/],
    [['pbi', '5', '--harness', 'gemini'], /--harness must be/],
    [['pbi', '5', '--format', 'xml'], /--format must be text or json/],
    [['pbi', '5', '--nope'], /unknown option --nope/],
  ])('rejects %j with exit code 2', async (args, message) => {
    const lines: string[] = [];
    expect(await runRunCli(args, { db, err: (l) => lines.push(l) })).toBe(2);
    expect(lines.join('\n')).toMatch(message);
  });

  it('streams JSON lines with the run header first, even with --format json off a TTY', async () => {
    const res = await run(['--dry-run', '--format', 'json'], true);
    expect(res.code).toBe(0);
    const events = res.stdout
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { type: string });
    expect(events[0]).toMatchObject({
      type: 'run.header',
      issue: 5,
      dryRun: true,
      harness: { name: 'claude' },
      models: { implementer: 'sonnet' },
    });
    expect(events.at(-1)).toMatchObject({ type: 'run.finished', outcome: 'dry_run' });
  });

  it('prints text on a TTY, header line first', async () => {
    const res = await run(['--dry-run'], true);
    const lines = res.stdout.trim().split('\n');
    expect(lines[0]).toMatch(/^run pbi-5-\S+ #5 o\/r \(dry run\): harness claude; planner=opus/);
    expect(lines.at(-1)).toBe('dry_run');
  });

  it('writes JSON lines without a TTY and says so for --format text', async () => {
    const res = await run(['--dry-run', '--format', 'text'], false);
    expect(JSON.parse(res.stdout.split('\n')[0] as string)).toMatchObject({ type: 'run.header' });
    expect(res.stderr).toMatch(/not a TTY/);
  });

  it('exits 3 when the run cannot start', async () => {
    const lines: string[] = [];
    const code = await runRunCli(['pbi', '5', '--repo', repo, '--dry-run'], {
      db,
      out: () => {},
      err: (l) => lines.push(l),
      pbi: {
        isTty: false,
        ops: {
          repoSlug: async () => {
            throw new Error('no remote');
          },
        },
      },
    });
    expect(code).toBe(3);
    expect(lines.join('\n')).toMatch(/no remote/);
  });
});

describe('dromos run plan', () => {
  const plan = {
    items: [{ key: 'a', title: 'First', body: 'do a', dependsOn: [] }],
    questions: [
      {
        id: 'q1',
        question: 'Which db?',
        options: ['sqlite', 'pg'],
        recommended: 'sqlite',
        why: 'w',
      },
    ],
    assumptions: [],
  };
  const repo = mkdtempSync(join(tmpdir(), 'dromos-run-plan-'));
  const run = async (args: string[], isTty: boolean, replies: string[] = []) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const created: string[][] = [];
    const code = await runRunCli(['plan', '40', '--repo', repo, ...args], {
      db,
      out: (t) => stdout.push(t),
      err: (l) => stderr.push(l),
      plan: {
        isTty,
        readLine: async () => replies.shift() ?? '',
        ops: {
          repoSlug: async () => 'o/r',
          readIssue: async () => ({
            number: 40,
            title: '[Feature] feat: f',
            body: 'b',
            labels: [],
            subIssues: [],
            blockedBy: [],
          }),
          makeHarness: () => ({
            version: async () => null,
            runPhase: async () => ({ result: plan, events: [], usage: null }),
          }),
          readComments: async () => [],
          comment: async () => {},
          addLabel: async () => {},
          removeLabel: async () => {},
          createIssues: async (_slug, _parent, _level, _plan, assumptions = []) => {
            created.push(assumptions);
            return [];
          },
          writePlan: () => {},
        },
      },
    });
    return {
      code,
      stdout: stdout.join(''),
      stderr: stderr.join('\n'),
      created,
    };
  };
  const finished = (stdout: string) =>
    stdout
      .trim()
      .split('\n')
      .map(
        (l) =>
          JSON.parse(l) as {
            type: string;
            data?: { unansweredQuestions?: number };
          },
      )
      .find((e) => e.type === 'phase.finished');

  it.each([
    [['plan'], /plan needs <nr>/],
    [['plan', 'x'], /positive integer/],
    [['plan', '40', '--answer', 'q1'], /<id>=<value>/],
    [['plan', '40', '--format', 'xml'], /--format must be text or json/],
  ])('rejects %j with exit code 2', async (args, message) => {
    const lines: string[] = [];
    expect(await runRunCli(args, { db, err: (l) => lines.push(l) })).toBe(2);
    expect(lines.join('\n')).toMatch(message);
  });

  it('asks on a TTY and Enter takes the recommendation', async () => {
    const res = await run([], true, ['']);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Which db?\n  1) sqlite (recommended)\n  2) pg');
    expect(res.stdout).toContain('phase.finished planner (opus), 0 unanswered question(s)');
    expect(res.created).toEqual([[]]);
  });

  it('answers by --answer without a prompt', async () => {
    const res = await run(['--answer', 'q1=pg'], true);
    expect(res.code).toBe(0);
    expect(res.stdout).not.toContain('Which db?');
  });

  it('rejects an --answer value that is not an option', async () => {
    const res = await run(['--answer', 'q1=typo', '--format', 'json'], false);
    expect(res.code).toBe(3);
    expect(res.stdout).toMatch(/not an option/);
    expect(res.created).toEqual([]);
  });

  it('--assume-recommended takes the recommendation without asking, even on a TTY', async () => {
    const res = await run(['--assume-recommended'], true);
    expect(res.code).toBe(0);
    expect(res.stdout).not.toContain('[Enter = ');
    expect(res.created).toEqual([['Which db? Assumed: sqlite']]);
  });

  it('off a TTY leaves questions unanswered and reports the count in phase.finished', async () => {
    const res = await run([], false);
    expect(res.code).toBe(2);
    expect(finished(res.stdout)?.data?.unansweredQuestions).toBe(1);
    expect(res.created).toEqual([]);
  });
});

describe('dromos run metrics', () => {
  function seedRunner(issue: number, fingerprint: string) {
    const finding = { fingerprint, blocking: true, fixed: false };
    db.insertEvent('dromos', 'outcome.finding', finding, { issue });
    db.insertEvent('dromos', 'outcome.fixRound', { cause: 'review_findings' }, { issue });
  }

  it('prints runs and aggregate as JSON by default, for the issues asked', async () => {
    seedRunner(7, 'aa');
    seedRunner(8, 'aa');
    seedRunner(9, 'zz');
    const r = await cli(['metrics', '--issues', '7,8']);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.out);
    expect(doc.runs.map((m: { issue: number }) => m.issue)).toEqual([7, 8]);
    expect(doc.aggregate.fixRounds).toBe(2);
    expect(doc.aggregate.repeatedFindings).toEqual([{ fingerprint: 'aa', runs: [7, 8], count: 2 }]);
  });

  it('prints a table with --format table', async () => {
    seedRunner(7, 'aa');
    const r = await cli(['metrics', '--issues', '7', '--format', 'table']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('#7');
    expect(r.out).toContain('fix rounds');
    expect(r.out).toContain('total');
  });

  it('filters by --since', async () => {
    seedRunner(7, 'aa');
    const r = await cli(['metrics', '--since', '2999-01-01T00:00Z']);
    expect(JSON.parse(r.out).runs).toEqual([]);
  });

  it('exits 2 without issues or since, on a bad format and on a bad date', async () => {
    expect((await cli(['metrics'])).code).toBe(2);
    expect((await cli(['metrics', '--issues', '7', '--format', 'xml'])).code).toBe(2);
    expect((await cli(['metrics', '--since', 'yesterday'])).code).toBe(2);
  });
});
