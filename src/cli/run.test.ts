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
