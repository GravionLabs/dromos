#!/usr/bin/env node
import { type Config, loadConfig } from './config.js';
import { reportStartupError, serve } from './serve.js';

let config: Config | undefined;
try {
  config = loadConfig();
  await serve(config);
} catch (error) {
  if (!reportStartupError(error, config)) throw error;
  process.exit(1);
}
