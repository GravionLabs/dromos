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
    const text = textOf(await client.callTool({ name: 'status', arguments: {} }));
    expect(text).toBe(JSON.stringify(JSON.parse(text), null, 2));
    expect(text).not.toBe('[]');
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
    expect(out.unackedByRole).toEqual({ orchestrator: 0, implementer: 2, reviewer: 0 });
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
    expect(textOf(res)).toBe(JSON.stringify(out, null, 2));
  });

  it('returns null gate/review and empty collections for a fresh run', async () => {
    addRun(6);
    const client = await bus.connect('orchestrator');
    const out = JSON.parse(
      textOf(await client.callTool({ name: 'status', arguments: { runId: 'run-6-1' } })),
    );
    expect(out).toMatchObject({
      lastGate: null,
      lastReview: null,
      unackedByRole: { orchestrator: 0, implementer: 0, reviewer: 0 },
    });
    expect(out.lastHookEvents).toEqual([]);
  });

  it('errors for an unknown run id', async () => {
    const client = await bus.connect('orchestrator');
    const res = await client.callTool({ name: 'status', arguments: { runId: 'nope' } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe('unknown run: nope');
  });

  it('keeps outputTail on every failed step, bounded, without mutating the stored run', async () => {
    addRun(7);
    const long = `${'x'.repeat(5000)}END`;
    const gate: GateResult = {
      passed: false,
      steps: [
        { name: 'a', command: 'a', exitCode: 2, durationMs: 1, outputTail: long },
        { name: 'b', command: 'b', exitCode: 3, durationMs: 1, outputTail: 'fail-b' },
      ],
    };
    bus.db.updateRun('run-7-1', { lastGate: gate });
    const client = await bus.connect('reviewer');
    const out = JSON.parse(
      textOf(await client.callTool({ name: 'status', arguments: { runId: 'run-7-1' } })),
    );
    expect(out.lastGate.steps[0].outputTail).toHaveLength(4000);
    expect(out.lastGate.steps[0].outputTail.endsWith('END')).toBe(true);
    expect(out.lastGate.steps[1].outputTail).toBe('fail-b');
    expect(bus.db.getRun('run-7-1')?.lastGate).toEqual(gate);
  });

  it('drops outputTail from every step of a passing gate', async () => {
    addRun(8);
    bus.db.updateRun('run-8-1', {
      lastGate: {
        passed: true,
        steps: [{ name: 'a', command: 'a', exitCode: 0, durationMs: 1, outputTail: 'noise' }],
      },
    });
    const client = await bus.connect('reviewer');
    const out = JSON.parse(
      textOf(await client.callTool({ name: 'status', arguments: { runId: 'run-8-1' } })),
    );
    expect(out.lastGate).toEqual({
      passed: true,
      steps: [{ name: 'a', command: 'a', exitCode: 0, durationMs: 1 }],
    });
  });

  it('reports only allowlisted hook fields and tolerates malformed data', async () => {
    addRun(9);
    bus.db.insertEvent('implementer', 'hook:idle', {
      cli: 'claude',
      secret: 'leak',
      sessionId: 's',
    });
    bus.db.insertEvent('implementer', 'task:done', { cli: 'other' });
    bus.db.insertEvent('reviewer', 'hook:busy', null);
    bus.db.insertEvent('orchestrator', 'hook:idle', { cli: 42, model: { a: 1 } });
    const client = await bus.connect('reviewer');
    const text = textOf(await client.callTool({ name: 'status', arguments: { runId: 'run-9-1' } }));
    expect(text).not.toContain('leak');
    const hooks = JSON.parse(text).lastHookEvents;
    const stripped = hooks.map(({ createdAt: _c, ...r }: Record<string, unknown>) => r);
    expect(stripped).toEqual([
      { role: 'implementer', cli: 'claude', model: null, state: 'idle' },
      { role: 'orchestrator', cli: null, model: null, state: 'idle' },
      { role: 'reviewer', cli: null, model: null, state: 'busy' },
    ]);
  });
});
