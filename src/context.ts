import type { BusEvents } from './bus-events.js';
import type { BusLog } from './bus-log.js';
import type { Config } from './config.js';
import type { Db } from './db.js';
import type { Role } from './schemas.js';

/** Everything a tool handler needs; `role` is bound to the MCP session that made the call. */
export interface ToolContext {
  role: Role;
  db: Db;
  config: Config;
  events: BusEvents;
  log: BusLog;
}
