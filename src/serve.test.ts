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

  const listenError = (code: string, syscall: string) =>
    Object.assign(new Error(code), { code, syscall });

  it('reports EACCES on listen as a permission error with host and port', () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(
      reportStartupError(listenError('EACCES', 'listen'), { host: '127.0.0.1', port: 80 }),
    ).toBe(true);
    expect(write).toHaveBeenCalledWith(
      'dromos: cannot listen on 127.0.0.1:80: permission denied\n',
    );
  });

  it('does not treat EACCES from another syscall (e.g. opening the db) as a listen failure', () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(reportStartupError(listenError('EACCES', 'open'))).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it('names the configured address generically when no config was loaded', () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(reportStartupError(listenError('EADDRINUSE', 'listen'))).toBe(true);
    expect(write).toHaveBeenCalledWith(
      'dromos: cannot listen on the configured address: address already in use\n',
    );
  });

  it('leaves unexpected errors unreported', () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(reportStartupError(new Error('boom'))).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });
});
