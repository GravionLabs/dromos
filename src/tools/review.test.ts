import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claimLease, leaseFile } from '../lease.js';
import type { Finding, Review } from '../schemas.js';
import { startTestBus, type TestBus, textOf } from '../test-helpers.js';

const finding = (severity: Finding['severity'], summary: string): Finding => ({
  severity,
  file: 'src/a.ts',
  line: 3,
  summary,
});

describe('submit_review', () => {
  let bus: TestBus;

  const addRun = (
    patch: { state?: 'implementing' | 'reviewing' | 'blocked'; round?: number } = {},
  ) =>
    bus.db.insertRun({
      id: 'run-1-1',
      repo: 'o/r',
      repoPath: '/repo',
      issueNumber: 1,
      issueTitle: 'Title',
      baseBranch: 'main',
      branch: 'agent/1-title',
      worktreePath: '/wt',
      state: patch.state ?? 'reviewing',
      round: patch.round ?? 1,
    });
  const submit = async (review: unknown, role: 'reviewer' | 'implementer' = 'reviewer') => {
    const client = await bus.connect(role);
    return client.callTool({ name: 'submit_review', arguments: { runId: 'run-1-1', review } });
  };

  beforeEach(async () => {
    bus = await startTestBus();
  });
  afterEach(async () => {
    await bus.close();
  });

  it('approves a review without blocking findings and notifies the orchestrator', async () => {
    addRun();
    const review: Review = {
      verdict: 'approve',
      summary: 'Looks good',
      findings: [finding('suggestion', 'rename x')],
    };
    const woken = vi.fn();
    bus.events.onMessageFor('orchestrator', woken);
    const result = await submit(review);
    expect(woken).toHaveBeenCalledTimes(1);
    expect(bus.readLog()).toMatch(/STATE\s+run-1-1 approved \(round 1\)/);
    expect(JSON.parse(textOf(result))).toEqual({ status: 'approved', round: 1 });
    expect(bus.db.getRun('run-1-1')).toMatchObject({
      state: 'approved',
      round: 1,
      lastReview: review,
    });
    const [msg] = bus.db.listUnacked('orchestrator');
    expect(msg).toMatchObject({
      from: 'reviewer',
      type: 'notice',
      payload: { runId: 'run-1-1', event: 'approved', summary: 'Looks good' },
    });
    expect(bus.readLog()).toMatch(
      /REVIEW\s+run-1-1 verdict=approve critical=0 important=0 suggestion=1/,
    );
  });

  it('treats an approve verdict with a critical finding as changes', async () => {
    addRun();
    const result = await submit({
      verdict: 'approve',
      summary: 's',
      findings: [finding('critical', 'data loss')],
    });
    expect(JSON.parse(textOf(result))).toEqual({ status: 'implementing', round: 2 });
    expect(bus.db.getRun('run-1-1')).toMatchObject({ state: 'implementing', round: 2 });
    const [msg] = bus.db.listUnacked('implementer');
    expect(msg).toMatchObject({ from: 'reviewer', type: 'review_result' });
    expect(msg?.payload).toMatchObject({ round: 2, findings: [finding('critical', 'data loss')] });
    expect(bus.db.listUnacked('orchestrator')).toHaveLength(0);
  });

  it('sends blocking findings first to the implementer with the round incremented', async () => {
    addRun();
    const result = await submit({
      verdict: 'changes',
      summary: 'Fix these',
      findings: [
        finding('suggestion', 'nit'),
        finding('important', 'must fix'),
        finding('critical', 'bug'),
      ],
    });
    expect(JSON.parse(textOf(result))).toEqual({ status: 'implementing', round: 2 });
    expect(bus.db.getRun('run-1-1')).toMatchObject({ state: 'implementing', round: 2 });
    const [msg] = bus.db.listUnacked('implementer');
    expect(msg).toMatchObject({ from: 'reviewer', type: 'review_result' });
    expect(msg?.payload).toEqual({
      runId: 'run-1-1',
      round: 2,
      summary: 'Fix these',
      findings: [
        finding('important', 'must fix'),
        finding('critical', 'bug'),
        finding('suggestion', 'nit'),
      ],
    });
    expect(bus.db.listUnacked('orchestrator')).toHaveLength(0);
  });

  it('blocks the run and notifies the orchestrator on the last round', async () => {
    addRun({ round: bus.config.maxRounds });
    const result = await submit({
      verdict: 'changes',
      summary: 'Still broken',
      findings: [finding('critical', 'bug')],
    });
    expect(JSON.parse(textOf(result)).status).toBe('blocked');
    expect(bus.db.getRun('run-1-1')).toMatchObject({
      state: 'blocked',
      round: bus.config.maxRounds + 1,
      lastReview: { verdict: 'changes', summary: 'Still broken' },
    });
    const [msg] = bus.db.listUnacked('orchestrator');
    expect(msg).toMatchObject({ type: 'notice' });
    expect(msg?.payload).toMatchObject({
      runId: 'run-1-1',
      event: 'blocked',
      findings: [finding('critical', 'bug')],
    });
    expect(bus.db.listUnacked('implementer')).toHaveLength(0);
  });

  it('sends a changes verdict with only suggestions back to the implementer', async () => {
    addRun();
    const result = await submit({
      verdict: 'changes',
      summary: 'Please rework',
      findings: [finding('suggestion', 'nit')],
    });
    expect(JSON.parse(textOf(result))).toEqual({ status: 'implementing', round: 2 });
    expect(bus.db.listUnacked('implementer')).toHaveLength(1);
  });

  it('still sends changes to the implementer one round before the limit', async () => {
    addRun({ round: bus.config.maxRounds - 1 });
    const result = await submit({
      verdict: 'changes',
      summary: 's',
      findings: [finding('important', 'fix')],
    });
    expect(JSON.parse(textOf(result))).toEqual({
      status: 'implementing',
      round: bus.config.maxRounds,
    });
  });

  it('commits the review even when logging and waking fail', async () => {
    addRun();
    vi.spyOn(bus.events, 'messageFor').mockImplementation(() => {
      throw new Error('wake down');
    });
    const result = await submit({ verdict: 'approve', summary: 's', findings: [] });
    expect(result.isError).toBeFalsy();
    expect(bus.db.getRun('run-1-1')?.state).toBe('approved');
  });

  it.each(['implementing', 'blocked'] as const)('rejects a run in state %s', async (state) => {
    addRun({ state });
    const result = await submit({ verdict: 'approve', summary: 's', findings: [] });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("needs 'reviewing'");
    expect(bus.db.getRun('run-1-1')?.state).toBe(state);
    expect(bus.db.listUnacked('orchestrator')).toHaveLength(0);
  });

  it('rejects a run that is not in reviewing', async () => {
    addRun({ state: 'implementing' });
    const result = await submit({ verdict: 'approve', summary: 's', findings: [] });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("needs 'reviewing'");
    expect(bus.db.getRun('run-1-1')?.state).toBe('implementing');
  });

  it('rejects an unknown run', async () => {
    const result = await submit({ verdict: 'approve', summary: 's', findings: [] });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('unknown run');
  });

  it('rejects a caller that is not the reviewer', async () => {
    addRun();
    const result = await submit({ verdict: 'approve', summary: 's', findings: [] }, 'implementer');
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('not allowed for role implementer');
    expect(bus.db.getRun('run-1-1')?.state).toBe('reviewing');
  });

  it('rejects an invalid review payload', async () => {
    addRun();
    const result = await submit({ verdict: 'maybe', summary: '' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/verdict|summary/);
    expect(bus.db.listUnacked('orchestrator')).toHaveLength(0);
    expect(bus.db.listUnacked('implementer')).toHaveLength(0);
    expect(bus.db.getRun('run-1-1')?.state).toBe('reviewing');
  });
});

describe('submit_review lease', () => {
  let bus: TestBus;
  let state: string;
  const leaseDir = () => join(state, 'leases');
  const file = () => leaseFile(leaseDir(), '/wt');
  const OLD = '2020-01-01T00:00:00Z';
  const heartbeat = () => JSON.parse(readFileSync(file(), 'utf8')).heartbeat;
  const age = () => {
    const lease = JSON.parse(readFileSync(file(), 'utf8'));
    writeFileSync(file(), `${JSON.stringify({ ...lease, heartbeat: OLD })}\n`);
  };
  const addRun = (round = 1) =>
    bus.db.insertRun({
      id: 'run-1-1',
      repo: 'o/r',
      repoPath: '/repo',
      issueNumber: 1,
      issueTitle: 'Title',
      baseBranch: 'main',
      branch: 'agent/1-title',
      worktreePath: '/wt',
      state: 'reviewing',
      round,
    });
  const claim = () => {
    mkdirSync(leaseDir(), { recursive: true });
    return claimLease(leaseDir(), { path: '/wt', issue: 1, branch: 'agent/1-title' });
  };
  const changes: Review = {
    verdict: 'changes',
    summary: 's',
    findings: [finding('critical', 'bug')],
  };
  const approve: Review = { verdict: 'approve', summary: 's', findings: [] };
  const submit = async (review: Review) => {
    const client = await bus.connect('reviewer');
    return client.callTool({ name: 'submit_review', arguments: { runId: 'run-1-1', review } });
  };

  beforeEach(async () => {
    state = mkdtempSync(join(tmpdir(), 'review-lease-'));
    vi.stubEnv('DROMOS_STATE_DIR', state);
    bus = await startTestBus();
  });
  afterEach(async () => {
    await bus.close();
    vi.unstubAllEnvs();
    rmSync(state, { recursive: true, force: true });
  });

  it.each([
    ['changes', changes],
    ['approve', approve],
  ] as const)('renews the heartbeat on a %s review', async (_name, review) => {
    addRun();
    await claim();
    age();
    await submit(review);
    await vi.waitFor(() => expect(heartbeat()).not.toBe(OLD));
  });

  it('removes the lease when the review blocks the run', async () => {
    addRun(bus.config.maxRounds);
    await claim();
    const result = await submit(changes);
    expect(JSON.parse(textOf(result)).status).toBe('blocked');
    await vi.waitFor(() => expect(existsSync(file())).toBe(false));
  });

  it('keeps the new state and logs when the lease cannot be released', async () => {
    addRun(bus.config.maxRounds);
    const real = join(state, 'real');
    mkdirSync(real);
    symlinkSync(real, leaseDir());
    const result = await submit(changes);
    expect(result.isError).toBeFalsy();
    expect(bus.db.getRun('run-1-1')?.state).toBe('blocked');
    await vi.waitFor(() => expect(bus.readLog()).toContain('lease release failed'));
  });
});
