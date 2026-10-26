import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolContext } from '../context.js';
import { type Message, parseTaskPayload, type TaskMessage } from '../schemas.js';
import { jsonResult } from './util.js';

export const DEFAULT_WAIT_SECONDS = 30;
export const INBOX_BATCH_SIZE = 20;

/** Default 30 s, never above the configured maximum, never negative. 0 means "do not wait". */
export function resolveWaitSeconds(requested: number | undefined, max: number): number {
  return Math.min(Math.max(requested ?? DEFAULT_WAIT_SECONDS, 0), max);
}

/** Task payloads come back typed; legacy rows that do not parse are returned unchanged. */
export function typeMessages(messages: Message[]): (Message | TaskMessage)[] {
  return messages.map((m) => {
    if (m.type !== 'task') return m;
    const parsed = parseTaskPayload(m.payload);
    return parsed.success ? ({ ...m, type: 'task', payload: parsed.data } as TaskMessage) : m;
  });
}

export function registerInboxTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'inbox',
    {
      description:
        'Return your unacknowledged messages (oldest first, max 20), waiting up to waitSeconds ' +
        'for a new one if there are none. Messages are NOT acknowledged automatically: after ' +
        'handling messages call `ack` with their ids, then call `inbox` again. ' +
        'An empty result just means nothing arrived; call `inbox` again.',
      inputSchema: {
        waitSeconds: z
          .number()
          .min(0)
          .optional()
          .describe(`Seconds to wait for a message (default ${DEFAULT_WAIT_SECONDS}, 0 = no wait)`),
      },
    },
    async ({ waitSeconds }, extra) => {
      const { role, agentId, db, events, config } = ctx;
      const pending = () => db.listUnacked(role, INBOX_BATCH_SIZE, agentId);

      const immediate = pending();
      const wait = resolveWaitSeconds(waitSeconds, config.inboxMaxWaitSeconds);
      if (immediate.length > 0 || wait === 0) {
        return jsonResult({ messages: typeMessages(immediate) });
      }

      // Checking and subscribing happen synchronously, so a post cannot slip in between.
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          unsubscribe();
          extra.signal.removeEventListener('abort', finish);
          resolve();
        };
        const timer = setTimeout(finish, wait * 1000);
        const unsubRole = events.onMessageFor(role, finish);
        const unsubAgent = events.onMessageForAgent(agentId, finish);
        const unsubscribe = () => {
          unsubRole();
          unsubAgent();
        };
        extra.signal.addEventListener('abort', finish, { once: true });
        if (extra.signal.aborted) {
          finish();
        }
      });

      return jsonResult({ messages: typeMessages(pending()) });
    },
  );
}
