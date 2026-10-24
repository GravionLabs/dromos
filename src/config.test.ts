import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigError, loadConfig } from './config.js';

describe('loadConfig', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dromos-config-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(name: string, content: unknown): string {
    const file = join(dir, name);
    writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
    return file;
  }

  it('returns the defaults when no config file exists', () => {
    const config = loadConfig(undefined, { env: {}, cwd: dir });
    expect(config).toEqual({
      host: '127.0.0.1',
      port: 4777,
      dataDir: join(dir, '.agents'),
      maxRounds: 3,
      inboxMaxWaitSeconds: 45,
      blockingSeverities: ['critical', 'important'],
      gate: { timeoutSeconds: 900, commands: [] },
      baseBranch: 'main',
      roles: {
        orchestrator: { cli: 'claude', model: null },
        implementer: { cli: 'claude', model: null },
        reviewer: { cli: 'copilot', model: null },
      },
      layouts: { default: 'windows' },
    });
  });

  it('merges overrides from ./dromos.config.json with the defaults', () => {
    write('dromos.config.json', {
      port: 5000,
      gate: { commands: [{ name: 'test', run: 'pnpm test' }] },
      roles: { reviewer: { model: 'GPT-Luna' } },
    });
    const config = loadConfig(undefined, { env: {}, cwd: dir });
    expect(config.port).toBe(5000);
    expect(config.host).toBe('127.0.0.1');
    expect(config.gate).toEqual({
      timeoutSeconds: 900,
      commands: [{ name: 'test', run: 'pnpm test' }],
    });
    expect(config.roles.reviewer).toEqual({ cli: 'copilot', model: 'GPT-Luna' });
    expect(config.roles.implementer).toEqual({ cli: 'claude', model: null });
  });

  it('uses DROMOS_CONFIG and resolves dataDir relative to that file', () => {
    const file = write('custom.json', { dataDir: 'state' });
    const config = loadConfig(undefined, { env: { DROMOS_CONFIG: file }, cwd: '/' });
    expect(config.dataDir).toBe(join(dir, 'state'));
  });

  it('prefers an explicit path over DROMOS_CONFIG', () => {
    const explicit = write('explicit.json', { port: 1111 });
    const fromEnv = write('env.json', { port: 2222 });
    const config = loadConfig(explicit, { env: { DROMOS_CONFIG: fromEnv }, cwd: dir });
    expect(config.port).toBe(1111);
  });

  it('accepts any model string without validation', () => {
    write('dromos.config.json', { roles: { implementer: { cli: 'copilot', model: 'x/y-z' } } });
    expect(loadConfig(undefined, { env: {}, cwd: dir }).roles.implementer.model).toBe('x/y-z');
  });

  it('names the invalid field in the error', () => {
    write('dromos.config.json', { port: 'abc', roles: { reviewer: { cli: 'vim' } } });
    expect(() => loadConfig(undefined, { env: {}, cwd: dir })).toThrow(ConfigError);
    try {
      loadConfig(undefined, { env: {}, cwd: dir });
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('port');
      expect(message).toContain('roles.reviewer.cli');
    }
  });

  it('rejects malformed JSON', () => {
    write('dromos.config.json', '{ nope');
    expect(() => loadConfig(undefined, { env: {}, cwd: dir })).toThrow(/invalid JSON/);
  });

  it('fails when an explicitly named file does not exist', () => {
    expect(() =>
      loadConfig(undefined, { env: { DROMOS_CONFIG: join(dir, 'missing.json') }, cwd: dir }),
    ).toThrow(/config file not found/);
  });

  describe('deprecated names', () => {
    it('falls back to ./agent-bus.config.json and warns once', () => {
      write('agent-bus.config.json', { port: 2222 });
      const warn = vi.fn();
      expect(loadConfig(undefined, { env: {}, cwd: dir, warn }).port).toBe(2222);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        'agent-bus.config.json is deprecated, rename to dromos.config.json',
      );
    });

    it('prefers dromos.config.json when both exist, without a warning', () => {
      write('dromos.config.json', { port: 1111 });
      write('agent-bus.config.json', { port: 2222 });
      const warn = vi.fn();
      expect(loadConfig(undefined, { env: {}, cwd: dir, warn }).port).toBe(1111);
      expect(warn).not.toHaveBeenCalled();
    });

    it('loads ./dromos.config.json without a warning', () => {
      write('dromos.config.json', { port: 1111 });
      const warn = vi.fn();
      expect(loadConfig(undefined, { env: {}, cwd: dir, warn }).port).toBe(1111);
      expect(warn).not.toHaveBeenCalled();
    });

    it('loads DROMOS_CONFIG without a warning', () => {
      const file = write('custom.json', { port: 3333 });
      const warn = vi.fn();
      expect(loadConfig(undefined, { env: { DROMOS_CONFIG: file }, cwd: '/', warn }).port).toBe(
        3333,
      );
      expect(warn).not.toHaveBeenCalled();
    });

    it('treats an empty DROMOS_CONFIG as set rather than falling back', () => {
      write('dromos.config.json', { port: 1111 });
      const warn = vi.fn();
      const env = { DROMOS_CONFIG: '' };
      expect(() => loadConfig(undefined, { env, cwd: dir, warn })).toThrow(
        new RegExp(`^invalid JSON in ${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: EISDIR`),
      );
      expect(warn).not.toHaveBeenCalled();
    });

    it('ignores AGENT_BUS_CONFIG and uses the normal lookup without a warning', () => {
      const old = write('old.json', { port: 2222 });
      write('dromos.config.json', { port: 1111 });
      const warn = vi.fn();
      const env = { AGENT_BUS_CONFIG: old };
      expect(loadConfig(undefined, { env, cwd: dir, warn }).port).toBe(1111);
      expect(warn).not.toHaveBeenCalled();
    });

    it('writes the default warning to stderr with the dromos prefix', () => {
      write('agent-bus.config.json', { port: 4444 });
      const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        loadConfig(undefined, { env: {}, cwd: dir });
        expect(spy).toHaveBeenCalledWith(
          'dromos: agent-bus.config.json is deprecated, rename to dromos.config.json\n',
        );
      } finally {
        spy.mockRestore();
      }
    });
  });
});
