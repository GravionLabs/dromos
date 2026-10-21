import type { ToolContext } from '../context.js';
import type { MessageType, Role } from '../schemas.js';

export const jsonResult = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
});

export const errorResult = (message: string) => ({
  isError: true as const,
  content: [{ type: 'text' as const, text: message }],
});

/** Logs a delivered bus message and wakes the recipient; never throws (best effort). */
export function logAndWake(
  ctx: ToolContext,
  from: Role,
  to: Role,
  type: MessageType,
  runId: string,
): void {
  try {
    ctx.log.logLine('MESSAGE', `${from} -> ${to} [${type}] ${runId}`);
    ctx.events.messageFor(to);
  } catch {
    // best effort
  }
}
