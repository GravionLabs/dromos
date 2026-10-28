import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildStateSnapshot,
  STATE_SCHEMA_PATH,
  StateSnapshotSchema,
  serializeStateSchema,
} from './state-snapshot.js';
import { startTestBus, type TestBus } from './test-helpers.js';

let bus: TestBus;
beforeEach(async () => {
  bus = await startTestBus();
});
afterEach(async () => {
  await bus.close();
});

const newRun = (id: string, issueNumber: number) => ({
  id,
  repo: 'GravionLabs/demo',
  repoPath: '/work/demo',
  issueNumber,
  issueTitle: 'Do the thing',
  baseBranch: 'main',
  branch: `agent/${issueNumber}`,
  worktreePath: `/work/wt-${issueNumber}`,
});

async function getState(headers: Record<string, string> = {}, method = 'GET'): Promise<Response> {
  return fetch(`${bus.http.url}/state`, { method, headers });
}

describe('GET /state', () => {
  it('returns an empty versioned snapshot on a fresh bus', async () => {
    const res = await getState();
    expect(res.status).toBe(200);
    const body = StateSnapshotSchema.parse(await res.json());
    expect(body).toMatchObject({ version: 1, agents: [], runs: [], attentions: [] });
  });

  it('lists agents, active runs and open attentions', async () => {
    bus.db.insertRun(newRun('run-7-1', 7));
    bus.db.insertRun(newRun('run-8-1', 8));
    bus.db.updateRun('run-7-1', {
      state: 'gating',
      round: 2,
      lastGate: {
        passed: false,
        steps: [
          { name: 'lint', command: 'x', exitCode: 0, durationMs: 1, outputTail: '' },
          { name: 'test', command: 'y', exitCode: 1, durationMs: 1, outputTail: '' },
        ],
      },
    });
    bus.db.updateRun('run-8-1', { state: 'pr_opened', prUrl: 'https://github.com/o/r/pull/9' });
    bus.db.insertAgent({
      id: 'impl-1',
      role: 'implementer',
      cli: 'claude',
      model: 'opus',
      state: 'busy',
    });
    const ingest = await fetch(`${bus.http.url}/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'attention',
        source: 'apm-hub/queue',
        agentId: null,
        issue: 7,
        runId: 'run-7-1',
        data: { kind: 'QUESTION', summary: 'which option?', pr: null },
      }),
    });
    expect(ingest.status).toBe(202);

    const body = StateSnapshotSchema.parse(await (await getState()).json());

    expect(body.agents).toEqual([
      expect.objectContaining({
        id: 'impl-1',
        role: 'implementer',
        client: 'claude',
        model: 'opus',
        state: 'busy',
        since: expect.any(String),
      }),
    ]);
    expect(body.runs).toEqual([
      {
        id: 'run-7-1',
        issue: 7,
        phase: 'gating',
        gateRounds: 2,
        lastGate: { passed: false, failedSteps: ['test'] },
        worktree: '/work/wt-7',
        pr: null,
      },
    ]);
    expect(body.attentions).toEqual([
      expect.objectContaining({ issue: 7, runId: 'run-7-1', kind: 'QUESTION' }),
    ]);
  });

  it('omits attentions that are no longer open', async () => {
    const ingest = await fetch(`${bus.http.url}/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'attention',
        source: 'apm-hub/queue',
        agentId: null,
        issue: null,
        runId: null,
        data: { kind: 'QUESTION', summary: 'q', pr: null },
      }),
    });
    const { id } = (await ingest.json()) as { id: number };
    await fetch(`${bus.http.url}/attention/${id}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'a', by: 'me' }),
    });
    expect(buildStateSnapshot(bus.db).attentions).toEqual([]);
  });

  it('rejects a foreign origin and a foreign host with 403', async () => {
    expect((await getState({ origin: 'http://evil.example' })).status).toBe(403);
    expect((await getState({ origin: bus.http.url })).status).toBe(200);
  });

  it('rejects other methods with 405', async () => {
    expect((await getState({}, 'POST')).status).toBe(405);
  });
});

describe('schema/state.schema.json', () => {
  it('matches the committed file (drift guard; run pnpm run schema)', () => {
    expect(readFileSync(STATE_SCHEMA_PATH, 'utf8')).toBe(serializeStateSchema());
  });
});
