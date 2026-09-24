import { startHttp } from './http.js';

const { url } = await startHttp({ host: '127.0.0.1', port: 4777 });
process.stderr.write(`agent-bus listening on ${url}\n`);
