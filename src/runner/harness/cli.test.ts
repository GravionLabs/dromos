import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { PhaseInput } from '../harness.js';
import { buildArgs, CliHarness } from './cli.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dromos-cli-harness-'));
  mkdirSync(join(dir, 'bin'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Puts an executable shell script named `name` on a private PATH and returns the env to use. */
function fakeCli(name: string, script: string): NodeJS.ProcessEnv {
  const file = join(dir, 'bin', name);
  writeFileSync(file, `#!/bin/sh\n${script}\n`);
  chmodSync(file, 0o755);
  return { ...process.env, PATH: `${join(dir, 'bin')}${delimiter}${process.env.PATH ?? ''}` };
}

const fixture = (name: string): string => join(import.meta.dirname, 'fixtures', name);

/** A fake `copilot` that prints a recorded output fixture. */
const copilotPrinting = (name: string): NodeJS.ProcessEnv =>
  fakeCli('copilot', `cat '${fixture(name)}'`);

const input = (): PhaseInput => ({
  prompt: 'do it',
  cwd: dir,
  model: 'sonnet',
  skills: [],
  allow: () => ({ allow: true }),
  schema: z.string(),
  timeoutMs: 5000,
});

describe('buildArgs', () => {
  it('passes the allowlist to claude as --allowedTools', () => {
    const args = buildArgs('claude', input(), ['git status', 'pnpm']);
    expect(args.slice(0, 2)).toEqual(['-p', 'do it']);
    expect(args).toContain('json');
    expect(args.slice(args.indexOf('--allowedTools') + 1)).toContain('Bash(git status:*)');
    expect(args).toContain('Bash(pnpm:*)');
  });

  it('passes one --allow-tool per entry to copilot and asks for JSON output', () => {
    const args = buildArgs('copilot', input(), ['git status', 'pnpm']);
    expect(
      args.slice(args.indexOf('--output-format'), args.indexOf('--output-format') + 2),
    ).toEqual(['--output-format', 'json']);
    expect(args.slice(0, 4)).toEqual(['-p', 'do it', '--model', 'sonnet']);
    expect(args).toContain('shell(git status)');
    expect(args).toContain('shell(pnpm)');
    expect(args.filter((a) => a === '--allow-tool')).toHaveLength(3);
  });
});

describe('CliHarness', () => {
  it('parses result and usage from claude json output', async () => {
    const env = fakeCli(
      'claude',
      `echo '{"type":"result","is_error":false,"result":"done","total_cost_usd":0.12,"usage":{"input_tokens":10,"output_tokens":5}}'`,
    );
    const out = await new CliHarness({ name: 'claude', env, commands: ['git status'] }).runPhase(
      input(),
    );
    expect(out.result).toBe('done');
    expect(out.usage).toEqual({ inputTokens: 10, outputTokens: 5, costUsd: 0.12 });
    expect(out.events[0]?.kind).toBe('message');
  });

  it('reports no usage when claude gives none', async () => {
    const env = fakeCli('claude', `echo '{"result":"ok"}'`);
    const out = await new CliHarness({ name: 'claude', env }).runPhase(input());
    expect(out.usage).toBeNull();
  });

  it('runs in the worktree and hands the prompt over', async () => {
    const env = fakeCli(
      'copilot',
      `pwd > "$PWD/seen"; echo "$@" >> "$PWD/seen"; echo '{"type":"assistant.message","data":{"content":"finished","toolRequests":[]}}'`,
    );
    const out = await new CliHarness({ name: 'copilot', env, commands: ['git log'] }).runPhase(
      input(),
    );
    expect(out.result).toBe('finished');
    const seen = readFileSync(join(dir, 'seen'), 'utf8');
    expect(seen).toContain('-p do it');
    expect(seen).toContain('--allow-tool shell(git log)');
  });

  it('parses text and usage from recorded copilot json output', async () => {
    const env = copilotPrinting('copilot-success.jsonl');
    const out = await new CliHarness({ name: 'copilot', env }).runPhase(input());
    expect(out.result).toBe('ok');
    expect(out.usage).toEqual({ inputTokens: 14171, outputTokens: 5, costUsd: null });
    expect(out.events[0]?.summary).toBe('ok');
  });

  it('sums the usage of all models and skips tool-request messages', async () => {
    const env = copilotPrinting('copilot-tools.jsonl');
    const out = await new CliHarness({ name: 'copilot', env }).runPhase({
      ...input(),
      schema: z.string().transform((t) => JSON.parse(t) as unknown),
    });
    expect(out.result).toEqual({ answer: 4 });
    expect(out.usage).toEqual({ inputTokens: 3000, outputTokens: 100, costUsd: null });
  });

  it('reports no usage when copilot gives none, never an estimate', async () => {
    const env = copilotPrinting('copilot-no-usage.jsonl');
    const out = await new CliHarness({ name: 'copilot', env }).runPhase(input());
    expect(out.result).toBe('ok');
    expect(out.usage).toBeNull();
  });

  it('fails on copilot output that is not JSONL or has no final message', async () => {
    const text = fakeCli('copilot', 'echo plain text');
    await expect(new CliHarness({ name: 'copilot', env: text }).runPhase(input())).rejects.toThrow(
      /not JSON/,
    );
    const empty = fakeCli('copilot', `echo '{"type":"result","exitCode":0}'`);
    await expect(new CliHarness({ name: 'copilot', env: empty }).runPhase(input())).rejects.toThrow(
      /no final assistant message/,
    );
  });

  it('fails on an error result, a non-zero exit and a timeout', async () => {
    const isError = fakeCli('claude', `echo '{"is_error":true,"result":"boom"}'`);
    await expect(
      new CliHarness({ name: 'claude', env: isError }).runPhase(input()),
    ).rejects.toThrow(/boom/);
    const exit = fakeCli('copilot', 'echo bad >&2; exit 3');
    await expect(new CliHarness({ name: 'copilot', env: exit }).runPhase(input())).rejects.toThrow(
      /exited with 3: bad/,
    );
    const slow = fakeCli('copilot', 'exec sleep 5');
    await expect(
      new CliHarness({ name: 'copilot', env: slow }).runPhase({ ...input(), timeoutMs: 100 }),
    ).rejects.toThrow(/timed out/);
  });

  it('reads the version, null when the binary fails', async () => {
    const env = fakeCli('claude', 'echo "2.1.0 (Claude Code)"');
    expect(await new CliHarness({ name: 'claude', env }).version()).toBe('2.1.0 (Claude Code)');
    const bad = fakeCli('copilot', 'exit 1');
    expect(await new CliHarness({ name: 'copilot', env: bad }).version()).toBeNull();
  });
});
