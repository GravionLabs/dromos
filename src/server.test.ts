import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
        expect(JSON.parse(textOf(result))).toEqual({ role });
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

    it('gives each connection its own session', async () => {
      const a = await bus.connect('implementer');
      const b = await bus.connect('reviewer');
      expect(JSON.parse(textOf(await a.callTool({ name: 'whoami', arguments: {} })))).toEqual({
        role: 'implementer',
      });
      expect(JSON.parse(textOf(await b.callTool({ name: 'whoami', arguments: {} })))).toEqual({
        role: 'reviewer',
      });
    });
  });
});
