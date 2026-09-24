import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type RunningHttp, startHttp } from './http.js';

describe('agent-bus server', () => {
  let http: RunningHttp;

  beforeEach(async () => {
    http = await startHttp({ host: '127.0.0.1', port: 0 });
  });

  afterEach(async () => {
    await http.close();
  });

  async function connect(role: string): Promise<Client> {
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${http.url}/mcp/${role}`)));
    return client;
  }

  it('answers ping with pong', async () => {
    const client = await connect('orchestrator');
    const result = await client.callTool({ name: 'ping', arguments: {} });
    expect(result.content).toEqual([{ type: 'text', text: 'pong' }]);
    await client.close();
  });

  it('lists the ping tool', async () => {
    const client = await connect('implementer');
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('ping');
    await client.close();
  });

  it('serves /health', async () => {
    const res = await fetch(`${http.url}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('returns 404 for unknown paths', async () => {
    const res = await fetch(`${http.url}/nope`);
    expect(res.status).toBe(404);
  });

  it('rejects a non-initialize POST without a session id', async () => {
    const res = await fetch(`${http.url}/mcp/orchestrator`, {
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
    const res = await fetch(`${http.url}/mcp/orchestrator`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
  });

  it('binds to 127.0.0.1 only', () => {
    expect(http.url.startsWith('http://127.0.0.1:')).toBe(true);
  });
});
