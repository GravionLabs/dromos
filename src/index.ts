#!/usr/bin/env node
import { join } from 'node:path';
import { runAttentionCli } from './cli/attention.js';
import { runRunCli } from './cli/run.js';
import { ConfigError, loadConfig } from './config.js';
import { openDb } from './db.js';
import { startHttp } from './http.js';

try {
  if (process.argv[2] === 'attention') {
    process.exitCode = await runAttentionCli(process.argv.slice(3));
  } else if (process.argv[2] === 'run') {
    process.exitCode = await runRunCli(process.argv.slice(3));
  } else {
    const config = loadConfig();
    const db = openDb(join(config.dataDir, 'bus.db'));
    const { url } = await startHttp({ config, db });
    process.stderr.write(`dromos listening on ${url}\n`);
  }
} catch (error) {
  if (error instanceof ConfigError) {
    process.stderr.write(`dromos: ${error.message}\n`);
    process.exit(1);
  }
  throw error;
}
