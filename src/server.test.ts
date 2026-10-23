import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_AGENTS } from './http.js';
import { startTestBus, type TestBus, textOf } from './test-helpers.js';

describe('agent-bus server', () => {
  let bus: TestBus;

  beforeEach(async () => {
    bus = await startTestBus();
  });

  afterEach(async () => {
    await bus.close();
  });

  it('answers ping with pong', async () => {
    const client = await bus.connect('orchestrator');
    const result = await client.callTool({ name: 'ping', arguments: {} });
    expect(result.content).toEqual([{ type: 'text', text: 'pong' }]);
  });

  it('lists the ping tool', async () => {
    const client = await bus.connect('implementer');
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('ping');
  });

  it('serves /health', async () => {
    const res = await fetch(`${bus.http.url}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('returns 404 for unknown paths', async () => {
    const res = await fetch(`${bus.http.url}/nope`);
    expect(res.status).toBe(404);
  });

  it('rejects a non-initialize POST without a session id', async () => {
    const res = await fetch(`${bus.http.url}/mcp/orchestrator`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects invalid JSON', async () => {
    const res = await fetch(`${bus.http.url}/mcp/orchestrator`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
  });

  it('binds to 127.0.0.1 only', () => {
    expect(bus.http.url.startsWith('http://127.0.0.1:')).toBe(true);
  });

  describe('role binding', () => {
    it.each(['orchestrator', 'implementer', 'reviewer'] as const)(
      'whoami returns %s for /mcp/%s',
      async (role) => {
        const client = await bus.connect(role);
        const result = await client.callTool({ name: 'whoami', arguments: {} });
        expect(JSON.parse(textOf(result))).toEqual(expect.objectContaining({ role }));
      },
    );

    it('returns 404 for an unknown role', async () => {
      const res = await fetch(`${bus.http.url}/mcp/admin`, { method: 'POST', body: '{}' });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'unknown role' });
    });

    it('returns 403 when a session id is used on another role URL', async () => {
      const init = await fetch(`${bus.http.url}/mcp/reviewer`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
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
      const sessionId = init.headers.get('mcp-session-id');
      expect(sessionId).toBeTruthy();
      const res = await fetch(`${bus.http.url}/mcp/implementer`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-session-id': sessionId ?? '',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      });
      expect(res.status).toBe(403);
    });

    describe('agent identity', () => {
      const whoami = async (c: Awaited<ReturnType<typeof bus.connect>>) =>
        JSON.parse(textOf(await c.callTool({ name: 'whoami', arguments: {} })));
      const initBody = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'x', version: '0' },
        },
      });
      const init = (headers: Record<string, string> = {}) =>
        fetch(`${bus.http.url}/mcp/implementer`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            ...headers,
          },
          body: initBody,
        });

      it('whoami returns the supplied X-Agent-Id and registers the agent', async () => {
        const client = await bus.connect('implementer', 'impl-a');
        expect(await whoami(client)).toEqual({ role: 'implementer', agentId: 'impl-a' });
        expect(bus.db.getAgent('impl-a')?.role).toBe('implementer');
      });

      it('mints an id when X-Agent-Id is missing and returns it in the header', async () => {
        const res = await init();
        const minted = res.headers.get('x-agent-id') ?? '';
        expect(minted).toMatch(/^implementer-[0-9a-f]{8}$/);
        expect(bus.db.getAgent(minted)?.role).toBe('implementer');
      });

      it('whoami returns the minted id', async () => {
        const client = await bus.connect('reviewer');
        const { agentId } = await whoami(client);
        expect(agentId).toMatch(/^reviewer-[0-9a-f]{8}$/);
      });

      it('emits agent.registered once per new agent', async () => {
        await bus.connect('implementer', 'impl-b');
        await bus.connect('implementer', 'impl-b');
        const registered = bus.db
          .listEvents('implementer')
          .filter((e) => e.kind === 'agent.registered');
        expect(registered).toHaveLength(1);
        expect(registered[0]?.data).toEqual({ role: 'implementer', cli: 'unknown', model: null });
        expect(bus.db.listAgents({ role: 'implementer' })).toHaveLength(1);
      });

      it('rejects an id already registered under another role with 409', async () => {
        await bus.connect('implementer', 'shared');
        const res = await fetch(`${bus.http.url}/mcp/reviewer`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'x-agent-id': 'shared',
          },
          body: initBody,
        });
        expect(res.status).toBe(409);
      });

      it('rejects an agent id equal to a role name with 400', async () => {
        expect((await init({ 'x-agent-id': 'reviewer' })).status).toBe(400);
      });

      it('persists X-Agent-Cli and X-Agent-Model and reports them in agent.registered', async () => {
        await init({ 'x-agent-id': 'impl-c', 'x-agent-cli': 'claude', 'x-agent-model': 'opus' });
        const agent = bus.db.getAgent('impl-c');
        expect([agent?.cli, agent?.model]).toEqual(['claude', 'opus']);
        const ev = bus.db.listEvents('implementer').find((e) => e.kind === 'agent.registered');
        expect(ev?.data).toEqual({ role: 'implementer', cli: 'claude', model: 'opus' });
      });

      it('rejects an invalid X-Agent-Cli without registering anything', async () => {
        expect((await init({ 'x-agent-id': 'impl-d', 'x-agent-cli': 'a b' })).status).toBe(400);
        expect(bus.db.getAgent('impl-d')).toBeUndefined();
      });

      it('rejects over-length, comma-joined and invalid model header values with 400', async () => {
        expect((await init({ 'x-agent-id': `a${'b'.repeat(128)}` })).status).toBe(400);
        expect((await init({ 'x-agent-id': 'one, two' })).status).toBe(400);
        expect((await init({ 'x-agent-model': 'a b' })).status).toBe(400);
        expect((await init({ 'x-agent-model': 'm'.repeat(129) })).status).toBe(400);
        expect((await init({ 'x-agent-cli': 'c'.repeat(65) })).status).toBe(400);
        expect(bus.db.listAgents()).toEqual([]);
      });

      it('answers 503 when the agent table is full, but still admits known agents', async () => {
        for (let i = 0; i < MAX_AGENTS; i++) {
          bus.db.insertAgent({ id: `fill-${i}`, role: 'implementer', cli: 'claude' });
        }
        expect((await init({ 'x-agent-id': 'one-too-many' })).status).toBe(503);
        expect(bus.db.getAgent('one-too-many')).toBeUndefined();
        expect(bus.db.listAgents()).toHaveLength(MAX_AGENTS);
        expect((await init({ 'x-agent-id': 'fill-0' })).status).toBe(200);
        expect(bus.db.listAgents()).toHaveLength(MAX_AGENTS);
      });

      it('lets only one of two concurrent initializes win for the same id', async () => {
        const initAs = (role: string) =>
          fetch(`${bus.http.url}/mcp/${role}`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              accept: 'application/json, text/event-stream',
              'x-agent-id': 'racer',
            },
            body: initBody,
          });
        const results = await Promise.all([initAs('implementer'), initAs('reviewer')]);
        const winners = results.filter((r) => r.headers.get('mcp-session-id'));
        expect(winners).toHaveLength(1);
        expect(winners[0]?.status).toBe(200);
        const loser = results.find((r) => !r.headers.get('mcp-session-id'));
        // 409 when the pre-check sees the winner's row, 400 when the in-callback re-check does.
        expect([400, 409]).toContain(loser?.status);
        expect(bus.db.listAgents()).toHaveLength(1);
        expect(bus.db.listEvents().filter((e) => e.kind === 'agent.registered')).toHaveLength(1);
      });

      it('re-checks inside the session callback when a registration lands after the pre-check', async () => {
        const realGetAgent = bus.db.getAgent.bind(bus.db);
        // The pre-check sees no row; a concurrent reviewer registration lands right after it.
        vi.spyOn(bus.db, 'getAgent').mockImplementationOnce((id) => {
          const seen = realGetAgent(id);
          bus.db.insertAgent({ id: 'racer', role: 'reviewer', cli: 'claude' });
          return seen;
        });
        const res = await init({ 'x-agent-id': 'racer' });
        expect(res.status).toBe(400);
        expect(res.headers.get('mcp-session-id')).toBeNull();
        expect(await res.json()).toMatchObject({
          jsonrpc: '2.0',
          error: { code: -32700, data: 'Error: agent racer is registered as reviewer' },
        });
        expect(bus.db.getAgent('racer')?.role).toBe('reviewer');
        expect(bus.db.listEvents().filter((e) => e.kind === 'agent.registered')).toEqual([]);
      });

      it('rolls back the agent row and logs when registration fails after the insert', async () => {
        vi.spyOn(bus.db, 'insertEvent').mockImplementationOnce(() => {
          throw new Error('disk full');
        });
        const res = await init({ 'x-agent-id': 'impl-fail' });
        expect(res.status).toBe(400);
        expect(res.headers.get('mcp-session-id')).toBeNull();
        expect(await res.json()).toMatchObject({
          error: { code: -32700, data: 'Error: agent registration failed' },
        });
        expect(bus.db.getAgent('impl-fail')).toBeUndefined();
        expect(bus.db.listEvents()).toEqual([]);
        expect(bus.readLog()).toContain('register impl-fail: Error: disk full');
        // The failed session is gone: the id can register cleanly afterwards.
        expect((await init({ 'x-agent-id': 'impl-fail' })).status).toBe(200);
        expect(bus.db.getAgent('impl-fail')?.state).toBe('idle');
      });

      it('rejects a malformed X-Agent-Id with 400', async () => {
        expect((await init({ 'x-agent-id': 'bad id!' })).status).toBe(400);
      });

      it('rejects a session used with another agent id with 403', async () => {
        const first = await init({ 'x-agent-id': 'owner' });
        const res = await fetch(`${bus.http.url}/mcp/implementer`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'mcp-session-id': first.headers.get('mcp-session-id') ?? '',
            'x-agent-id': 'intruder',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
        });
        expect(res.status).toBe(403);
      });
    });

    it('gives each connection its own session', async () => {
      const a = await bus.connect('implementer');
      const b = await bus.connect('reviewer');
      expect(JSON.parse(textOf(await a.callTool({ name: 'whoami', arguments: {} })))).toMatchObject(
        { role: 'implementer' },
      );
      expect(JSON.parse(textOf(await b.callTool({ name: 'whoami', arguments: {} })))).toMatchObject(
        { role: 'reviewer' },
      );
    });
  });
});
