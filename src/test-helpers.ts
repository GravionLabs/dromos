import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { BusEvents } from './bus-events.js';
import { type Config, ConfigSchema } from './config.js';
import { type Db, openDb } from './db.js';
import { type RunningHttp, startHttp } from './http.js';
import type { Role } from './schemas.js';

export interface TestBus {
  http: RunningHttp;
  db: Db;
  config: Config;
  events: BusEvents;
  /** Contents of the bus log file ('' when nothing was logged). */
  readLog(): string;
  connect(role: Role): Promise<Client>;
  close(): Promise<void>;
}

/** Starts a bus on a random port with an in-memory database. */
export async function startTestBus(overrides: Record<string, unknown> = {}): Promise<TestBus> {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-bus-test-'));
  const config = ConfigSchema.parse({ port: 0, dataDir, ...overrides });
  const db = openDb(':memory:');
  const events = new BusEvents();
  const http = await startHttp({ config, db, events });
  const clients: Client[] = [];
  return {
    http,
    db,
    config,
    events,
    readLog() {
      try {
        return readFileSync(join(config.dataDir, 'bus.log'), 'utf8');
      } catch {
        return '';
      }
    },
    async connect(role) {
      const client = new Client({ name: `test-${role}`, version: '0.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${http.url}/mcp/${role}`)));
      clients.push(client);
      return client;
    },
    async close() {
      await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
      await http.close();
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export function textOf(result: unknown): string {
  const content = (result as { content: { type: string; text: string }[] }).content;
  return content.map((c) => c.text).join('');
}
