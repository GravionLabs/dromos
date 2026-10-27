import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import {
  type CanUseTool,
  type Options,
  query,
  type SDKMessage,
  type SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { execa } from 'execa';
import { z } from 'zod';
import type { Harness, PhaseInput, PhaseOutput, RunEvent, Usage } from '../harness.js';

/** The part of the SDK's `query` this adapter uses; tests pass recorded messages instead. */
export type QueryFn = (params: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>;

export interface ClaudeHarnessOptions {
  query?: QueryFn;
  /** `claude` binary for `--version`; defaults to `claude` on `PATH`. */
  bin?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

/** Name, client version and SDK version for the `phase.*` header event. */
export interface HarnessHeader {
  name: 'claude';
  version: string | null;
  sdk: string | null;
}

/** Version of the installed `@anthropic-ai/claude-agent-sdk`, `null` when it cannot be read. */
export function sdkVersion(): string | null {
  try {
    const entry = createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk');
    const pkg = JSON.parse(readFileSync(join(dirname(entry), 'package.json'), 'utf8')) as {
      version?: unknown;
    };
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

/** JSON Schema of the phase output for the SDK; `null` where the schema is not an object. */
function outputSchema(schema: z.ZodType): Record<string, unknown> | null {
  const { $schema: _ignored, ...json } = z.toJSONSchema(schema) as Record<string, unknown>;
  return json.type === 'object' ? json : null;
}

/** Strips a Markdown code fence a model may wrap around its JSON. */
function unfence(text: string): string {
  const match = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(text);
  return match?.[1] ?? text.trim();
}

function describeInput(input: unknown): string {
  if (typeof input !== 'object' || input === null) return '';
  const rec = input as Record<string, unknown>;
  for (const key of ['command', 'file_path', 'path', 'pattern']) {
    if (typeof rec[key] === 'string') return ` ${rec[key]}`;
  }
  return '';
}

/**
 * Runs a phase with the Claude Agent SDK: the permission callback decides every tool call, the
 * output is JSON validated against the phase schema, one retry with the validation error appended.
 * The headless-CLI fallback is `CliHarness` as `claude-cli`.
 */
export class ClaudeHarness implements Harness {
  readonly name = 'claude';
  private readonly run: QueryFn;
  private readonly bin: string;
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly now: () => Date;

  constructor(options: ClaudeHarnessOptions = {}) {
    this.run = options.query ?? ((params) => query(params));
    this.bin = options.bin ?? 'claude';
    this.env = options.env;
    this.now = options.now ?? (() => new Date());
  }

  /** Output of `claude --version`, `null` when it cannot be read. */
  async version(): Promise<string | null> {
    const res = await execa(this.bin, ['--version'], { reject: false, env: this.env });
    const line = res.exitCode === 0 ? String(res.stdout).split('\n')[0]?.trim() : '';
    return line ? line : null;
  }

  async header(): Promise<HarnessHeader> {
    return { name: this.name, version: await this.version(), sdk: sdkVersion() };
  }

  async runPhase(input: PhaseInput): Promise<PhaseOutput> {
    const events: RunEvent[] = [];
    const event = (kind: RunEvent['kind'], summary: string): void => {
      events.push({ at: this.now().toISOString(), kind, summary: summary.slice(0, 500) });
    };

    const abort = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, input.timeoutMs);

    const canUseTool: CanUseTool = async (tool, toolInput) => {
      const decision = input.allow(tool, toolInput);
      if (decision.allow) return { behavior: 'allow', updatedInput: toolInput };
      event('permission_denied', `${tool}${describeInput(toolInput)}: ${decision.reason}`);
      return { behavior: 'deny', message: decision.reason };
    };

    const format = outputSchema(input.schema);
    const options: Options = {
      cwd: input.cwd,
      model: input.model,
      canUseTool,
      settingSources: ['project'],
      skills: input.skills,
      abortController: abort,
      ...(format ? { outputFormat: { type: 'json_schema', schema: format } } : {}),
      ...(this.env ? { env: this.env as Record<string, string> } : {}),
    };

    let prompt = input.prompt;
    let tokensIn = 0;
    let tokensOut = 0;
    let cost = 0;
    try {
      for (let attempt = 0; ; attempt++) {
        const result = await this.attempt(prompt, options, event);
        if (result.subtype !== 'success' || result.is_error) {
          const detail = 'errors' in result ? result.errors.join('; ') : result.result;
          throw new Error(`claude reported ${result.subtype}: ${detail || '(no message)'}`);
        }
        tokensIn += result.usage.input_tokens;
        tokensOut += result.usage.output_tokens;
        cost += result.total_cost_usd;

        const checked = this.validate(input.schema, result);
        if (checked.ok) {
          const usage: Usage = { inputTokens: tokensIn, outputTokens: tokensOut, costUsd: cost };
          return { result: checked.value, events, usage };
        }
        if (attempt > 0) {
          throw new Error(`claude output does not match the phase schema: ${checked.error}`);
        }
        event('message', `invalid output, retrying: ${checked.error}`);
        prompt = `${input.prompt}\n\nYour previous answer was rejected:\n${checked.error}\n\nAnswer again with valid JSON only.`;
      }
    } catch (error) {
      if (timedOut) throw new Error(`claude timed out after ${String(input.timeoutMs)} ms`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /** One `query()` call; returns its `result` message. */
  private async attempt(
    prompt: string,
    options: Options,
    event: (kind: RunEvent['kind'], summary: string) => void,
  ): Promise<SDKResultMessage> {
    let result: SDKResultMessage | undefined;
    for await (const message of this.run({ prompt, options })) {
      if (message.type === 'assistant') {
        for (const block of message.message.content) {
          if (block.type === 'tool_use')
            event('tool', `${block.name}${describeInput(block.input)}`);
        }
      } else if (message.type === 'result') {
        result = message;
      }
    }
    if (!result) throw new Error('claude ended without a result message');
    return result;
  }

  /** Parses structured output, or the JSON in the text result, with the phase schema. */
  private validate(
    schema: z.ZodType,
    result: Extract<SDKResultMessage, { subtype: 'success' }>,
  ): { ok: true; value: unknown } | { ok: false; error: string } {
    let candidate: unknown = result.structured_output;
    if (candidate === undefined) {
      try {
        candidate = JSON.parse(unfence(result.result));
      } catch (error) {
        return { ok: false, error: `not valid JSON: ${(error as Error).message}` };
      }
    }
    const parsed = schema.safeParse(candidate);
    return parsed.success
      ? { ok: true, value: parsed.data }
      : { ok: false, error: z.prettifyError(parsed.error) };
  }
}
