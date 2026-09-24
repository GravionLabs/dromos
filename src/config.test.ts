import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.js';

describe('loadConfig', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-bus-config-'));
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

  it('merges overrides from ./agent-bus.config.json with the defaults', () => {
    write('agent-bus.config.json', {
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

  it('uses AGENT_BUS_CONFIG and resolves dataDir relative to that file', () => {
    const file = write('custom.json', { dataDir: 'state' });
    const config = loadConfig(undefined, { env: { AGENT_BUS_CONFIG: file }, cwd: '/' });
    expect(config.dataDir).toBe(join(dir, 'state'));
  });

  it('prefers an explicit path over AGENT_BUS_CONFIG', () => {
    const explicit = write('explicit.json', { port: 1111 });
    const fromEnv = write('env.json', { port: 2222 });
    const config = loadConfig(explicit, { env: { AGENT_BUS_CONFIG: fromEnv }, cwd: dir });
    expect(config.port).toBe(1111);
  });

  it('accepts any model string without validation', () => {
    write('agent-bus.config.json', { roles: { implementer: { cli: 'copilot', model: 'x/y-z' } } });
    expect(loadConfig(undefined, { env: {}, cwd: dir }).roles.implementer.model).toBe('x/y-z');
  });

  it('names the invalid field in the error', () => {
    write('agent-bus.config.json', { port: 'abc', roles: { reviewer: { cli: 'vim' } } });
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
    write('agent-bus.config.json', '{ nope');
    expect(() => loadConfig(undefined, { env: {}, cwd: dir })).toThrow(/invalid JSON/);
  });

  it('fails when an explicitly named file does not exist', () => {
    expect(() =>
      loadConfig(undefined, { env: { AGENT_BUS_CONFIG: join(dir, 'missing.json') }, cwd: dir }),
    ).toThrow(/config file not found/);
  });
});
