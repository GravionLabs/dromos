import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildProgram, runCli } from './program.js';
import { runRunCli } from './run.js';

describe('buildProgram', () => {
  it('registers serve, attention and run but no role or up', () => {
    const names = buildProgram().commands.map((c) => c.name());
    expect(names).toEqual(['serve', 'attention', 'run']);
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

  it('forwards run args to the existing run parser', async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    vi.stubEnv('DROMOS_CONFIG', join(tmpdir(), 'dromos-missing-config.json'));
    const expected = await runRunCli([]);
    expect(await runCli(['run'])).toBe(expected);
    expect(await runCli(['run', 'export', '--bogus', 'x'])).toBe(
      await runRunCli(['export', '--bogus', 'x']),
    );
  });
});
