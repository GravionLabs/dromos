import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GateResult, Review } from '../schemas.js';
import { startTestBus, type TestBus, textOf } from '../test-helpers.js';

describe('status', () => {
  let bus: TestBus;

  const addRun = (issue: number) =>
    bus.db.insertRun({
      id: `run-${issue}-1`,
      repo: 'o/r',
      repoPath: '/repo',
      issueNumber: issue,
      issueTitle: `Title ${issue}`,
      baseBranch: 'main',
      branch: `feat/${issue}`,
      worktreePath: '/wt',
      state: 'implementing',
      round: 1,
    });

  beforeEach(async () => {
    bus = await startTestBus();
  });
  afterEach(async () => {
    await bus.close();
  });

  it('lists all runs newest first with summary fields, for any role', async () => {
    addRun(1);
    addRun(2);
    bus.db.updateRun('run-1-1', { prUrl: 'https://x/pr/1' });
    for (const role of ['orchestrator', 'implementer', 'reviewer'] as const) {
      const client = await bus.connect(role);
      const list = JSON.parse(textOf(await client.callTool({ name: 'status', arguments: {} })));
      expect(list.map((r: { id: string }) => r.id)).toEqual(['run-2-1', 'run-1-1']);
      expect(list[1]).toEqual({
        id: 'run-1-1',
        issue: 1,
        title: 'Title 1',
        state: 'implementing',
        round: 1,
        updatedAt: expect.any(String),
        prUrl: 'https://x/pr/1',
      });
    }
  });

  it('returns an empty list when there are no runs, as 2-space JSON', async () => {
    const client = await bus.connect('reviewer');
    const res = await client.callTool({ name: 'status', arguments: {} });
    expect(textOf(res)).toBe('[]');
    addRun(1);
    expect(textOf(await client.callTool({ name: 'status', arguments: {} }))).toContain('\n  {\n');
  });

  it('returns the full run with trimmed gate, review, unacked counts and hook events', async () => {
    addRun(5);
    const gate: GateResult = {
      passed: false,
      steps: [
        { name: 'build', command: 'b', exitCode: 0, durationMs: 1, outputTail: 'ok-noise' },
        { name: 'test', command: 't', exitCode: 1, durationMs: 2, outputTail: 'boom' },
      ],
    };
    const review: Review = { verdict: 'changes', summary: 'Fix', findings: [] };
    bus.db.updateRun('run-5-1', { lastGate: gate, lastReview: review });
    const msg = (to: 'implementer' | 'reviewer') =>
      bus.db.insertMessage({
        from: 'orchestrator',
        to,
        type: 'task',
        runId: 'run-5-1',
        payload: {},
      });
    msg('implementer');
    msg('implementer');
    const acked = msg('reviewer');
    bus.db.ackMessage(acked.id, 'reviewer');
    bus.db.insertEvent('implementer', 'hook:idle', { role: 'implementer', cli: 'claude' });
    bus.db.insertEvent('implementer', 'hook:busy', {
      role: 'implementer',
      cli: 'claude',
      model: 'opus',
    });
    bus.db.insertEvent('reviewer', 'hook:idle', { role: 'reviewer', cli: 'copilot' });

    const client = await bus.connect('implementer');
    const res = await client.callTool({ name: 'status', arguments: { runId: 'run-5-1' } });
    const out = JSON.parse(textOf(res));
    expect(out).toMatchObject({ id: 'run-5-1', issueNumber: 5, state: 'implementing' });
    expect(out.lastReview).toEqual(review);
    expect(out.lastGate.passed).toBe(false);
    expect(out.lastGate.steps[0]).toEqual({
      name: 'build',
      command: 'b',
      exitCode: 0,
      durationMs: 1,
    });
    expect(out.lastGate.steps[1].outputTail).toBe('boom');
    expect(out.unackedByRole).toEqual({ implementer: 2 });
    expect(out.lastHookEvents).toEqual([
      {
        role: 'implementer',
        cli: 'claude',
        model: 'opus',
        state: 'busy',
        createdAt: expect.any(String),
      },
      {
        role: 'reviewer',
        cli: 'copilot',
        model: null,
        state: 'idle',
        createdAt: expect.any(String),
      },
    ]);
    expect(textOf(res)).toContain('\n  "id": "run-5-1"');
  });

  it('returns null gate/review and empty collections for a fresh run', async () => {
    addRun(6);
    const client = await bus.connect('orchestrator');
    const out = JSON.parse(
      textOf(await client.callTool({ name: 'status', arguments: { runId: 'run-6-1' } })),
    );
    expect(out).toMatchObject({ lastGate: null, lastReview: null, unackedByRole: {} });
    expect(out.lastHookEvents).toEqual([]);
  });

  it('errors for an unknown run id', async () => {
    const client = await bus.connect('orchestrator');
    const res = await client.callTool({ name: 'status', arguments: { runId: 'nope' } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe('unknown run: nope');
  });
});
