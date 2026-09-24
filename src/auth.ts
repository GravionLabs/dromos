import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { Role } from './schemas.js';

/** Throws a readable MCP error unless `actual` is one of the `allowed` roles. */
export function requireRole(tool: string, actual: Role, ...allowed: Role[]): void {
  if (!allowed.includes(actual)) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `tool ${tool} is not allowed for role ${actual} (allowed: ${allowed.join(', ')})`,
    );
  }
}
