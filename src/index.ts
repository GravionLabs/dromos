import { ConfigError, loadConfig } from './config.js';
import { startHttp } from './http.js';

try {
  const config = loadConfig();
  const { url } = await startHttp({ host: config.host, port: config.port });
  process.stderr.write(`agent-bus listening on ${url}\n`);
} catch (error) {
  if (error instanceof ConfigError) {
    process.stderr.write(`agent-bus: ${error.message}\n`);
    process.exit(1);
  }
  throw error;
}
