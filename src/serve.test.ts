import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigSchema } from './config.js';
import { reportStartupError, serve } from './serve.js';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  await new Promise((r) => server.close(r));
  return port;
}

describe('serve', () => {
  afterEach(() => vi.restoreAllMocks());

  it('listens on the configured port and answers /health', async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const port = await freePort();
    const dataDir = mkdtempSync(join(tmpdir(), 'dromos-serve-'));
    const running = await serve(ConfigSchema.parse({ port, dataDir }));
    try {
      expect(running.url).toBe(`http://127.0.0.1:${port}`);
      const res = await fetch(`${running.url}/health`);
      expect(res.status).toBe(200);
    } finally {
      await running.close();
    }
  });

  it('rejects with EADDRINUSE when the port is taken', async () => {
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
    const { port } = blocker.address() as { port: number };
    const dataDir = mkdtempSync(join(tmpdir(), 'dromos-serve-'));
    try {
      await expect(serve(ConfigSchema.parse({ port, dataDir }))).rejects.toMatchObject({
        code: 'EADDRINUSE',
      });
    } finally {
      await new Promise((r) => blocker.close(r));
    }
  });
});

describe('reportStartupError', () => {
  afterEach(() => vi.restoreAllMocks());

  it('leaves unexpected errors unreported', () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(reportStartupError(new Error('boom'))).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });
});
