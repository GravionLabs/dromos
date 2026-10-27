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
  const args = ['-p', input.prompt, '--model', input.model, '--allow-tool', 'write'];
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
    const { text, usage } =
      this.name === 'copilot' ? { text: stdout.trim(), usage: null } : parseClaude(stdout);
    const event: RunEvent = {
      at: new Date().toISOString(),
      kind: 'message',
      summary: (text || '(empty)').slice(0, 500),
    };
    return { result: input.schema.parse(text), events: [event], usage };
  }
}
