import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BusEventSchema } from './events/schema.js';
import { startTestBus, type TestBus } from './test-helpers.js';

describe('agent.state events', () => {
  let bus: TestBus;

  beforeEach(async () => {
    bus = await startTestBus();
  });

  afterEach(async () => {
    await bus.close();
  });

  const hook = (state: string, headers: Record<string, string> = {}, role = 'implementer') =>
    fetch(`${bus.http.url}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ role, cli: 'claude', state }),
    });
  const stateEvents = (role = 'implementer') =>
    bus.db
      .listEvents(role)
      .filter((e) => e.kind === 'agent.state')
      .map((e) => e.data);

  it('maps a busy hook to busy and emits agent.state', async () => {
    await bus.connect('implementer', 'impl-1');
    expect((await hook('busy')).status).toBe(204);
    expect(bus.db.getAgent('impl-1')?.state).toBe('busy');
    expect(stateEvents()).toEqual([{ state: 'busy' }]);
  });

  it('maps an idle hook back to idle', async () => {
    await bus.connect('implementer', 'impl-1');
    await hook('busy');
    await hook('idle');
    expect(bus.db.getAgent('impl-1')?.state).toBe('idle');
    expect(stateEvents()).toEqual([{ state: 'idle' }, { state: 'busy' }]); // newest first
  });

  it('emits nothing when the state does not change', async () => {
    await bus.connect('implementer', 'impl-1');
    await hook('idle');
    await hook('busy');
    await hook('busy');
    expect(stateEvents()).toEqual([{ state: 'busy' }]);
  });

  it('targets the agent named by X-Agent-Id', async () => {
    await bus.connect('implementer', 'impl-1');
    await bus.connect('implementer', 'impl-2');
    await hook('busy', { 'x-agent-id': 'impl-1' });
    expect(bus.db.getAgent('impl-1')?.state).toBe('busy');
    expect(bus.db.getAgent('impl-2')?.state).toBe('idle');
  });

  it('ignores an X-Agent-Id that belongs to another role', async () => {
    await bus.connect('reviewer', 'rev-1');
    expect((await hook('busy', { 'x-agent-id': 'rev-1' })).status).toBe(204);
    expect(bus.db.getAgent('rev-1')?.state).toBe('idle');
    expect(stateEvents('reviewer')).toEqual([]);
  });

  it('still accepts a hook when no agent is registered for the role', async () => {
    expect((await hook('busy')).status).toBe(204);
    expect(stateEvents()).toEqual([]);
  });

  /** Opens a raw MCP session for the agent and returns its session id. */
  const open = async (agentId: string): Promise<string> => {
    const res = await fetch(`${bus.http.url}/mcp/implementer`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'x-agent-id': agentId,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'x', version: '0' },
        },
      }),
    });
    await res.text();
    return res.headers.get('mcp-session-id') ?? '';
  };
  /** Ends a raw MCP session with DELETE, like a client leaving. */
  const end = async (sessionId: string, agentId: string): Promise<void> => {
    await fetch(`${bus.http.url}/mcp/implementer`, {
      method: 'DELETE',
      headers: { 'mcp-session-id': sessionId, 'x-agent-id': agentId },
    });
  };
  const openAndClose = async (agentId: string): Promise<void> => end(await open(agentId), agentId);

  it('marks the agent exited when its session closes', async () => {
    await openAndClose('impl-1');
    await expect.poll(() => bus.db.getAgent('impl-1')?.state, { timeout: 2000 }).toBe('exited');
    expect(stateEvents()).toEqual([{ state: 'exited' }]);
  });

  it('does not target an exited agent from a role-only hook', async () => {
    await openAndClose('impl-1');
    await expect.poll(() => bus.db.getAgent('impl-1')?.state).toBe('exited');
    await hook('busy');
    expect(bus.db.getAgent('impl-1')?.state).toBe('exited');
  });

  it('resets an exited agent to idle when it reconnects with the same id', async () => {
    await openAndClose('impl-1');
    await expect.poll(() => bus.db.getAgent('impl-1')?.state).toBe('exited');
    const sessionId = await open('impl-1');
    expect(bus.db.getAgent('impl-1')?.state).toBe('idle');
    expect(stateEvents()).toEqual([{ state: 'idle' }, { state: 'exited' }]); // newest first
    await end(sessionId, 'impl-1');
    await expect.poll(() => bus.db.getAgent('impl-1')?.state).toBe('exited');
  });

  it('keeps the agent alive until its last session closes', async () => {
    const first = await open('impl-1');
    const second = await open('impl-1');
    await end(first, 'impl-1');
    await new Promise((r) => setTimeout(r, 100));
    expect(bus.db.getAgent('impl-1')?.state).toBe('idle');
    expect(stateEvents()).toEqual([]);
    await end(second, 'impl-1');
    await expect.poll(() => bus.db.getAgent('impl-1')?.state).toBe('exited');
  });

  it('ignores a role-only hook when two live agents share the role', async () => {
    await bus.connect('implementer', 'impl-1');
    await bus.connect('implementer', 'impl-2');
    await hook('busy');
    expect(bus.db.getAgent('impl-1')?.state).toBe('idle');
    expect(bus.db.getAgent('impl-2')?.state).toBe('idle');
    expect(stateEvents()).toEqual([]);
  });

  it('applies a role-only hook to the single live agent when a sibling has exited', async () => {
    await openAndClose('impl-old');
    await expect.poll(() => bus.db.getAgent('impl-old')?.state).toBe('exited');
    await bus.connect('implementer', 'impl-new');
    await hook('busy');
    expect(bus.db.getAgent('impl-new')?.state).toBe('busy');
    expect(bus.db.getAgent('impl-old')?.state).toBe('exited');
    expect(stateEvents()).toEqual([{ state: 'busy' }, { state: 'exited' }]);
  });

  it('logs and drops an agent event that fails envelope validation, keeping the state change', async () => {
    // The runs table accepts any length, the event envelope caps runId at 128 code points.
    const runId = 'r'.repeat(129);
    const envelope = {
      id: 0,
      type: 'agent.state',
      at: new Date().toISOString(),
      source: 'implementer',
      agentId: 'impl-x',
      issue: null,
      data: { state: 'busy' },
    };
    expect(BusEventSchema.safeParse({ ...envelope, runId: 'r'.repeat(128) }).success).toBe(true);
    expect(BusEventSchema.safeParse({ ...envelope, runId }).success).toBe(false);
    bus.db.insertRun({
      id: runId,
      repo: 'GravionLabs/demo',
      repoPath: '/work/demo',
      issueNumber: 1,
      issueTitle: 'Do the thing',
      baseBranch: 'main',
      branch: 'agent/1-do-the-thing',
      worktreePath: '/work/wt-demo-1',
    });
    bus.db.insertAgent({ id: 'impl-x', role: 'implementer', cli: 'claude', runId });
    expect((await hook('busy', { 'x-agent-id': 'impl-x' })).status).toBe(204);
    expect(bus.db.getAgent('impl-x')?.state).toBe('busy');
    expect(stateEvents()).toEqual([]);
    expect(bus.readLog()).toContain(
      'dropped invalid agent.state event for agent impl-x (implementer)',
    );
  });

  it('logs and drops an agent.registered event that fails validation, keeping the agent', async () => {
    // No request can reach this branch: a new agent has no run, and the X-Agent-Id, X-Agent-Cli
    // and X-Agent-Model checks in http.ts are stricter than the envelope. The guard is defensive,
    // so the only way to exercise it is to hand it a row the envelope rejects (runId > 128).
    const realInsert = bus.db.insertAgent.bind(bus.db);
    vi.spyOn(bus.db, 'insertAgent').mockImplementationOnce((agent) => ({
      ...realInsert(agent),
      runId: 'r'.repeat(129),
    }));
    await bus.connect('implementer', 'impl-v');
    expect(bus.db.getAgent('impl-v')?.state).toBe('idle');
    expect(bus.db.listEvents().filter((e) => e.kind === 'agent.registered')).toEqual([]);
    expect(bus.readLog()).toContain(
      'dropped invalid agent.registered event for agent impl-v (implementer)',
    );
  });

  it('logs an ERROR and still closes when the database is gone during shutdown', async () => {
    const local = await startTestBus();
    try {
      await local.connect('implementer', 'impl-1');
      local.db.close();
      await expect(local.http.close()).resolves.toBeUndefined();
      expect(local.readLog()).toMatch(
        /^\d{2}:\d{2}:\d{2} ERROR {8}mark impl-1 exited: TypeError: The database connection is not open$/m,
      );
    } finally {
      rmSync(local.config.dataDir, { recursive: true, force: true });
    }
  });
});
