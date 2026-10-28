import { Command, CommanderError } from 'commander';
import { runEventsCommand } from '../cli-events.js';
import { type Config, loadConfig } from '../config.js';
import { type RunningServe, reportStartupError, serve } from '../serve.js';
import { runAttentionCli } from './attention.js';
import { runConfigCli, runInitCli } from './config.js';
import { runPlanCli, runRunCli } from './run.js';
import { runStatusCli } from './status.js';

/** A pass-through subcommand: receives its raw args, resolves to an exit code. */
type Action = (args: string[]) => Promise<number>;

export interface CliHooks {
  /** Called with the running server after `serve` started (lets tests close it). */
  onServe?: (running: RunningServe) => void;
}

export function buildProgram(
  onResult: (code: number) => void = () => {},
  hooks: CliHooks = {},
): Command {
  const program = new Command('dromos')
    .description('Local MCP bus coordinating interactive agents')
    .exitOverride();

  program
    .command('serve')
    .description('start the bus (MCP, /health, /events) in the foreground')
    .action(async () => {
      let config: Config | undefined;
      try {
        config = loadConfig();
        const running = await serve(config);
        hooks.onServe?.(running);
      } catch (error) {
        if (!reportStartupError(error, config)) throw error;
        onResult(1);
      }
    });

  program
    .command('events')
    .description('query the bus event log (GET /events)')
    .option('--issue <n>', 'issue number')
    .option('--type <a,b>', 'event type(s), comma-separated')
    .option('--source <a,b>', 'event source(s), comma-separated')
    .option('--kind <a,b>', 'progress data.kind(s), comma-separated')
    .option('--agent-id <id>', 'agent id')
    .option('--since <iso>', 'inclusive lower bound on createdAt')
    .option('--until <iso>', 'exclusive upper bound on createdAt')
    .option('--after <id>', 'only events with an id greater than this')
    .option('--limit <n>', 'page size, 1 to 1000')
    .option('--all', 'follow pages until all matching events are printed')
    .option('--json', 'print JSON (default when stdout is not a TTY)')
    .option('--table', 'print a table (default on a TTY)')
    .option('--url <base>', 'bus base URL (default DROMOS_URL, else host and port from config)')
    .action(async (opts: Record<string, string | boolean | undefined>) => {
      const { agentId, url, ...rest } = opts;
      const base =
        (url as string | undefined) ??
        process.env.DROMOS_URL ??
        (() => {
          const c = loadConfig();
          return `http://${c.host}:${c.port}`;
        })();
      onResult(
        await runEventsCommand(
          { ...rest, agentId: agentId as string | undefined, url: base },
          {
            stdout: (t) => process.stdout.write(t),
            stderr: (t) => process.stderr.write(`${t}\n`),
            isTTY: process.stdout.isTTY,
          },
        ),
      );
    });

  const passThrough = (name: string, description: string, run: Action): void => {
    program
      .command(name)
      .description(description)
      .argument('[args...]')
      .allowUnknownOption()
      .helpOption(false)
      .action(async (args: string[]) => onResult(await run(args)));
  };
  passThrough('attention', 'answer or list attention requests', runAttentionCli);
  passThrough(
    'run',
    'run and inspect runs (run pbi <nr>, run feature|epic <nr>, run plan <nr>, run export <issue>, run metrics)',
    runRunCli,
  );
  passThrough(
    'plan',
    'plan a Feature into PBIs or a PBI into Tasks (plan feature|pbi <nr>)',
    runPlanCli,
  );
  passThrough(
    'status',
    'status table of an Epic, Feature or PBI from GitHub and the event store (status <nr>)',
    runStatusCli,
  );
  passThrough(
    'init',
    'create or update .dromos/config.json of a repository (init [--repo PATH] [--stack S] [--test-full CMD] [--dry-run])',
    runInitCli,
  );
  passThrough(
    'config',
    'validate or describe the runner config (config check [--repo PATH], config schema)',
    runConfigCli,
  );

  return program;
}

/** Runs the dromos CLI; resolves to the exit code once the command finished (`serve` resolves after startup). */
export async function runCli(argv: string[], hooks: CliHooks = {}): Promise<number> {
  let code = 0;
  const program = buildProgram((c) => {
    code = c;
  }, hooks);
  if (argv.length === 0) {
    process.stdout.write(program.helpInformation());
    return 0;
  }
  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode;
    throw error;
  }
  return code;
}
