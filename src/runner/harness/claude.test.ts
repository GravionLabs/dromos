import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { PhaseInput } from '../harness.js';
import { ClaudeHarness, type QueryFn, sdkVersion } from './claude.js';

const fixture = (name: string): SDKMessage[] =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'),
  ) as SDKMessage[];

/** A `query` that replays one fixture per call and records what it was called with. */
function replay(...runs: string[]): {
  query: QueryFn;
  calls: { prompt: string; options: Options }[];
} {
  const calls: { prompt: string; options: Options }[] = [];
  const query: QueryFn = (params) => {
    calls.push(params);
    const name = runs[Math.min(calls.length, runs.length) - 1] ?? '';
    return (async function* () {
      for (const message of fixture(name)) yield message;
    })();
  };
  return { query, calls };
}

const schema = z.strictObject({ status: z.literal('done'), commits: z.number().int() });

const input = (over: Partial<PhaseInput> = {}): PhaseInput => ({
  prompt: 'implement #1',
  cwd: '/work/wt',
  model: 'sonnet',
  skills: ['implementation'],
  allow: () => ({ allow: true }),
  schema,
  timeoutMs: 5000,
  ...over,
});

describe('ClaudeHarness.runPhase', () => {
  it('returns the validated structured output, the trace and the usage', async () => {
    const { query, calls } = replay('claude-success');
    const out = await new ClaudeHarness({ query }).runPhase(input());
    expect(out.result).toEqual({ status: 'done', commits: 2 });
    expect(out.events.map((e) => [e.kind, e.summary])).toEqual([
      ['tool', 'Bash git status'],
      ['tool', 'Edit src/a.ts'],
    ]);
    expect(out.usage).toEqual({ inputTokens: 100, outputTokens: 40, costUsd: 0.05 });
    expect(calls).toHaveLength(1);
  });

  it('passes model, cwd, skills and the JSON schema to the SDK', async () => {
    const { query, calls } = replay('claude-success');
    await new ClaudeHarness({ query }).runPhase(input());
    const options = calls[0]?.options;
    expect(options?.model).toBe('sonnet');
    expect(options?.cwd).toBe('/work/wt');
    expect(options?.skills).toEqual(['implementation']);
    expect(options?.settingSources).toEqual(['project']);
    expect(options?.outputFormat?.type).toBe('json_schema');
    expect(options?.outputFormat?.schema).toMatchObject({
      type: 'object',
      required: ['status', 'commits'],
    });
    expect(options?.outputFormat?.schema).not.toHaveProperty('$schema');
  });

  it('accepts JSON in a code fence when there is no structured output', async () => {
    const { query } = replay('claude-fenced-text');
    const out = await new ClaudeHarness({ query }).runPhase(input());
    expect(out.result).toEqual({ status: 'done', commits: 1 });
  });

  it('retries once with the validation error appended', async () => {
    const { query, calls } = replay('claude-invalid', 'claude-success');
    const out = await new ClaudeHarness({ query }).runPhase(input());
    expect(out.result).toEqual({ status: 'done', commits: 2 });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.prompt).toContain('implement #1');
    expect(calls[1]?.prompt).toContain('rejected');
    expect(calls[1]?.prompt).toMatch(/status/);
    expect(out.usage).toEqual({ inputTokens: 200, outputTokens: 80, costUsd: 0.1 });
    expect(out.events.some((e) => e.summary.startsWith('invalid output, retrying'))).toBe(true);
  });

  it('fails when the retry is invalid too', async () => {
    const { query, calls } = replay('claude-invalid');
    await expect(new ClaudeHarness({ query }).runPhase(input())).rejects.toThrow(
      /does not match the phase schema/,
    );
    expect(calls).toHaveLength(2);
  });

  it('does not retry an SDK error result', async () => {
    const { query, calls } = replay('claude-error');
    await expect(new ClaudeHarness({ query }).runPhase(input())).rejects.toThrow(
      /error_max_turns: hit the turn limit/,
    );
    expect(calls).toHaveLength(1);
  });

  it('fails without a result message', async () => {
    const query: QueryFn = () => (async function* () {})();
    await expect(new ClaudeHarness({ query }).runPhase(input())).rejects.toThrow(
      /without a result/,
    );
  });

  it('aborts and reports a timeout', async () => {
    const query: QueryFn = ({ options }) =>
      (async function* () {
        await new Promise<void>((_, reject) => {
          options.abortController?.signal.addEventListener('abort', () =>
            reject(new Error('aborted')),
          );
        });
        yield* [] as SDKMessage[];
      })();
    await expect(new ClaudeHarness({ query }).runPhase(input({ timeoutMs: 20 }))).rejects.toThrow(
      /timed out after 20 ms/,
    );
  });
});

describe('permission callback', () => {
  it('maps the allow decision to the SDK permission result and traces denials', async () => {
    const { query, calls } = replay('claude-success');
    const out = await new ClaudeHarness({ query }).runPhase(
      input({
        allow: (tool) =>
          tool === 'Bash' ? { allow: false, reason: 'push is not allowed' } : { allow: true },
      }),
    );
    const canUseTool = calls[0]?.options.canUseTool;
    const ctx = { signal: new AbortController().signal } as never;
    expect(await canUseTool?.('Edit', { file_path: 'a' }, ctx)).toEqual({
      behavior: 'allow',
      updatedInput: { file_path: 'a' },
    });
    expect(await canUseTool?.('Bash', { command: 'git push' }, ctx)).toEqual({
      behavior: 'deny',
      message: 'push is not allowed',
    });
    // the trace array is shared, so a denial after the phase still lands in it
    expect(out.events.filter((e) => e.kind === 'permission_denied')).toEqual([
      expect.objectContaining({ summary: 'Bash git push: push is not allowed' }),
    ]);
  });
});

describe('header', () => {
  let dir = '';
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads the SDK version from its package', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(sdkVersion()).toBe(pkg.dependencies['@anthropic-ai/claude-agent-sdk']);
  });

  it('combines `claude --version` with the SDK version', async () => {
    dir = mkdtempSync(join(tmpdir(), 'dromos-claude-'));
    const bin = join(dir, 'claude');
    writeFileSync(bin, '#!/bin/sh\necho "2.1.311 (Claude Code)"\n');
    chmodSync(bin, 0o755);
    const header = await new ClaudeHarness({ bin }).header();
    expect(header).toEqual({ name: 'claude', version: '2.1.311 (Claude Code)', sdk: sdkVersion() });
  });

  it('reports a missing binary as null', async () => {
    const header = await new ClaudeHarness({ bin: '/nonexistent/claude' }).header();
    expect(header.version).toBeNull();
  });
});
