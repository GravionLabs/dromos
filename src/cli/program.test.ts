import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordEvent } from '../event-store.js';
import type { RunningServe } from '../serve.js';
import { startTestBus } from '../test-helpers.js';
import { buildProgram, runCli } from './program.js';

describe('buildProgram', () => {
  it('registers serve, events, attention and run but no role or up', () => {
    const names = buildProgram().commands.map((c) => c.name());
    expect(names).toEqual(['serve', 'events', 'attention', 'run']);
  });
});

describe('runCli', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('prints help and exits 0 without arguments', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    expect(await runCli([])).toBe(0);
    expect(String(out.mock.calls[0]?.[0])).toContain('serve');
  });

  it('exits 1 for an unknown command', async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(await runCli(['up'])).toBe(1);
  });

  it('serve exits 1 with a one-line message when the port is occupied', async () => {
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
    const { port } = blocker.address() as { port: number };
    const dir = mkdtempSync(join(tmpdir(), 'dromos-cli-'));
    const file = join(dir, 'dromos.config.json');
    writeFileSync(file, JSON.stringify({ port, dataDir: 'data' }));
    vi.stubEnv('DROMOS_CONFIG', file);
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      expect(await runCli(['serve'])).toBe(1);
    } finally {
      await new Promise((r) => blocker.close(r));
    }
    expect(err).toHaveBeenCalledWith(
      `dromos: cannot listen on 127.0.0.1:${port}: address already in use\n`,
    );
  });

  it('serve exits 1 on a config error', async () => {
    vi.stubEnv('DROMOS_CONFIG', join(tmpdir(), 'dromos-missing-config.json'));
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(await runCli(['serve'])).toBe(1);
    expect(String(err.mock.calls[0]?.[0])).toMatch(/^dromos: /);
  });

  it('forwards run args unchanged to the run parser', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(await runCli(['run', 'export', '--bogus', 'x'])).toBe(2);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('unknown option --bogus'));
  });

  it('forwards attention args unchanged to the attention parser', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(await runCli(['attention'])).toBe(2);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('missing subcommand'));
  });

  it('serve starts the bus and answers /health', async () => {
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const { port } = probe.address() as { port: number };
    await new Promise((r) => probe.close(r));
    const dir = mkdtempSync(join(tmpdir(), 'dromos-cli-'));
    const file = join(dir, 'dromos.config.json');
    writeFileSync(file, JSON.stringify({ port, dataDir: 'data' }));
    vi.stubEnv('DROMOS_CONFIG', file);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    let running: RunningServe | undefined;
    try {
      expect(await runCli(['serve'], { onServe: (r) => (running = r) })).toBe(0);
      expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
    } finally {
      await running?.close();
    }
  });
});

describe('runCli events', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  const seed = (bus: Awaited<ReturnType<typeof startTestBus>>) =>
    recordEvent(bus.db, bus.events, 'cli-src', {
      id: 0,
      at: '2030-01-01T00:00:00.000Z',
      source: 'test',
      type: 'agent.state',
      agentId: 'cli-agent',
      issue: 9,
      runId: null,
      data: { state: 'idle' },
    });

  it('maps --agent-id, reads DROMOS_URL and prefers --url over it', async () => {
    const bus = await startTestBus();
    try {
      const row = seed(bus);
      const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
      vi.stubEnv('DROMOS_URL', bus.http.url);
      expect(await runCli(['events', '--json', '--agent-id', 'cli-agent'])).toBe(0);
      const body = JSON.parse(String(out.mock.calls[0]?.[0])) as { events: { id: number }[] };
      expect(body.events.map((e) => e.id)).toEqual([row.id]);

      out.mockClear();
      const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      vi.stubEnv('DROMOS_URL', 'http://127.0.0.1:1');
      expect(await runCli(['events', '--json', '--url', bus.http.url])).toBe(0);
      expect(await runCli(['events'])).toBe(1);
      expect(String(err.mock.calls[0]?.[0])).toContain('bus not running at http://127.0.0.1:1');
    } finally {
      await bus.close();
    }
  });

  it('exits 2 for a query the server rejects', async () => {
    const bus = await startTestBus();
    try {
      vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      expect(await runCli(['events', '--url', bus.http.url, '--limit', '5000'])).toBe(2);
    } finally {
      await bus.close();
    }
  });
});
