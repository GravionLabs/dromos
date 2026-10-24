import { join } from 'node:path';
import { ConfigError, loadConfig } from './config.js';
import { openDb } from './db.js';
import { startHttp } from './http.js';

try {
  const config = loadConfig();
  const db = openDb(join(config.dataDir, 'bus.db'));
  const { url } = await startHttp({ config, db });
  process.stderr.write(`dromos listening on ${url}\n`);
} catch (error) {
  if (error instanceof ConfigError) {
    process.stderr.write(`dromos: ${error.message}\n`);
    process.exit(1);
  }
  throw error;
}
