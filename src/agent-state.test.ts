import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

  /** Opens a raw MCP session for the agent and ends it with DELETE, like a client leaving. */
  const openAndClose = async (agentId: string): Promise<void> => {
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
    const sessionId = res.headers.get('mcp-session-id') ?? '';
    await res.text();
    await fetch(`${bus.http.url}/mcp/implementer`, {
      method: 'DELETE',
      headers: { 'mcp-session-id': sessionId, 'x-agent-id': agentId },
    });
  };

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
    await bus.connect('implementer', 'impl-1');
    expect(bus.db.getAgent('impl-1')?.state).toBe('idle');
    expect(stateEvents()).toEqual([{ state: 'idle' }, { state: 'exited' }]); // newest first
  });

  it('ignores a role-only hook when two live agents share the role', async () => {
    await bus.connect('implementer', 'impl-1');
    await bus.connect('implementer', 'impl-2');
    await hook('busy');
    expect(bus.db.getAgent('impl-1')?.state).toBe('idle');
    expect(bus.db.getAgent('impl-2')?.state).toBe('idle');
  });
});
