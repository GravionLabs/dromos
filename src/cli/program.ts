import { Command, CommanderError } from 'commander';
import { type Config, loadConfig } from '../config.js';
import { reportStartupError, serve } from '../serve.js';
import { runAttentionCli } from './attention.js';
import { runRunCli } from './run.js';

/** A pass-through subcommand: receives its raw args, resolves to an exit code. */
type Action = (args: string[]) => Promise<number>;

export function buildProgram(onResult: (code: number) => void = () => {}): Command {
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
        await serve(config);
      } catch (error) {
        if (!reportStartupError(error, config)) throw error;
        onResult(1);
      }
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
  passThrough('run', 'inspect runs (run export <issue>)', runRunCli);

  return program;
}

/** Runs the dromos CLI; resolves to the exit code once the command finished (`serve` resolves after startup). */
export async function runCli(argv: string[]): Promise<number> {
  let code = 0;
  const program = buildProgram((c) => {
    code = c;
  });
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
