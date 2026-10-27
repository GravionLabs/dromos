import { execa } from 'execa';
import { z } from 'zod';
import type { Harness, HarnessName, PhaseInput, PhaseOutput, RunEvent, Usage } from '../harness.js';
import { ALLOWED_COMMANDS } from '../permissions.js';

// Spike harness: drives the headless CLIs once per phase. Unlike the SDK adapters it cannot call
// `PhaseInput.allow` per tool call; the allowlist is handed over as CLI flags instead, and the git
// guardrails of `permissions.ts` do not apply (the spike measures what the CLIs can do on their own).

/** Built-in tools besides shell commands that an implementer phase needs. */
const FILE_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep'];

export interface CliHarnessOptions {
  name: HarnessName;
  /** Binary to run; defaults to `copilot` for `copilot`, else `claude`, looked up on `PATH`. */
  bin?: string;
  /** Command prefixes the phase may run; defaults to the built-in allowlist. */
  commands?: readonly string[];
  env?: NodeJS.ProcessEnv;
}

/** Arguments of one headless run, per client. */
export function buildArgs(
  name: HarnessName,
  input: Pick<PhaseInput, 'prompt' | 'model'>,
  commands: readonly string[],
): string[] {
  if (name !== 'copilot') {
    const tools = [...FILE_TOOLS, ...commands.map((c) => `Bash(${c}:*)`)];
    return [
      '-p',
      input.prompt,
      '--output-format',
      'json',
      '--model',
      input.model,
      '--allowedTools',
      ...tools,
    ];
  }
  const args = [
    '-p',
    input.prompt,
    '--model',
    input.model,
    '--output-format',
    'json',
    '--allow-tool',
    'write',
  ];
  for (const c of commands) args.push('--allow-tool', `shell(${c})`);
  return args;
}

const ClaudeResultSchema = z.object({
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  total_cost_usd: z.number().min(0).optional(),
  usage: z
    .object({ input_tokens: z.number().int().min(0), output_tokens: z.number().int().min(0) })
    .partial()
    .optional(),
});

function parseClaude(stdout: string): { text: string; usage: Usage | null } {
  const parsed = ClaudeResultSchema.safeParse(JSON.parse(stdout));
  if (!parsed.success)
    throw new Error(`unexpected claude output: ${z.prettifyError(parsed.error)}`);
  const { is_error, result, total_cost_usd, usage } = parsed.data;
  if (is_error) throw new Error(`claude reported an error: ${result ?? '(no message)'}`);
  const reported = usage?.input_tokens !== undefined && usage.output_tokens !== undefined;
  return {
    text: result ?? '',
    usage: reported
      ? {
          inputTokens: usage.input_tokens ?? 0,
          outputTokens: usage.output_tokens ?? 0,
          costUsd: total_cost_usd ?? null,
        }
      : null,
  };
}

const COUNT = z.number().int().min(0);
const CopilotEventSchema = z.looseObject({ type: z.string(), data: z.unknown().optional() });
const CopilotMessageSchema = z.looseObject({
  content: z.string().optional(),
  toolRequests: z.array(z.unknown()).optional(),
});
const CopilotUsageSchema = z.looseObject({
  accountingSnapshot: z.looseObject({
    modelMetrics: z.record(
      z.string(),
      z.looseObject({ usage: z.object({ inputTokens: COUNT, outputTokens: COUNT }).partial() }),
    ),
  }),
});

/**
 * Parses `copilot --output-format json` (JSONL): the text is the last assistant message that is not
 * a tool request, the usage the sum over the models of the last `session.usage_checkpoint`. Copilot
 * reports credits, not dollars, so `costUsd` stays `null`; no checkpoint gives `usage: null`.
 */
function parseCopilot(stdout: string): { text: string; usage: Usage | null } {
  let text: string | null = null;
  let metrics: z.infer<typeof CopilotUsageSchema> | null = null;
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      throw new Error(`unexpected copilot output, not JSON: ${line.slice(0, 200)}`);
    }
    const event = CopilotEventSchema.parse(json);
    if (event.type === 'assistant.message') {
      const message = CopilotMessageSchema.safeParse(event.data);
      if (message.success && !message.data.toolRequests?.length) text = message.data.content ?? '';
    } else if (event.type === 'session.usage_checkpoint') {
      const usage = CopilotUsageSchema.safeParse(event.data);
      if (usage.success) metrics = usage.data;
    }
  }
  if (text === null) throw new Error('copilot output has no final assistant message');
  const models = metrics ? Object.values(metrics.accountingSnapshot.modelMetrics) : [];
  const reported = models.length > 0 && models.every((m) => m.usage.outputTokens !== undefined);
  return {
    text: text.trim(),
    usage: reported
      ? {
          inputTokens: models.reduce((sum, m) => sum + (m.usage.inputTokens ?? 0), 0),
          outputTokens: models.reduce((sum, m) => sum + (m.usage.outputTokens ?? 0), 0),
          costUsd: null,
        }
      : null,
  };
}

export class CliHarness implements Harness {
  readonly name: HarnessName;
  private readonly bin: string;
  private readonly commands: readonly string[];
  private readonly env: NodeJS.ProcessEnv | undefined;

  constructor(options: CliHarnessOptions) {
    this.name = options.name;
    this.bin = options.bin ?? (options.name === 'copilot' ? 'copilot' : 'claude');
    this.commands = options.commands ?? ALLOWED_COMMANDS;
    this.env = options.env;
  }

  /** Output of `<bin> --version`, `null` when it cannot be read. */
  async version(): Promise<string | null> {
    const res = await execa(this.bin, ['--version'], { reject: false, env: this.env });
    const line = res.exitCode === 0 ? String(res.stdout).split('\n')[0]?.trim() : '';
    return line ? line : null;
  }

  async runPhase(input: PhaseInput): Promise<PhaseOutput> {
    const res = await execa(this.bin, buildArgs(this.name, input, this.commands), {
      cwd: input.cwd,
      env: this.env,
      timeout: input.timeoutMs,
      reject: false,
      stdin: 'ignore',
    });
    if (res.timedOut) throw new Error(`${this.bin} timed out after ${String(input.timeoutMs)} ms`);
    if (res.exitCode !== 0) {
      const tail = String(res.stderr || res.stdout)
        .trim()
        .slice(-500);
      throw new Error(`${this.bin} exited with ${String(res.exitCode)}: ${tail}`);
    }
    const stdout = String(res.stdout);
    const { text, usage } = this.name === 'copilot' ? parseCopilot(stdout) : parseClaude(stdout);
    const event: RunEvent = {
      at: new Date().toISOString(),
      kind: 'message',
      summary: (text || '(empty)').slice(0, 500),
    };
    return { result: input.schema.parse(text), events: [event], usage };
  }
}
