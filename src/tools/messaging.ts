import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolContext } from '../context.js';
import { MessageTypeSchema, RoleSchema } from '../schemas.js';
import { errorResult, jsonResult } from './util.js';

export function registerMessagingTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'post',
    {
      description:
        "Send a message to another agent role. Use type 'chat' for free-form questions; " +
        'workflow messages (task, gate_result, review_request, review_result, notice) are ' +
        'normally created by the workflow tools, not by you.',
      inputSchema: {
        to: RoleSchema.describe('Role that receives the message'),
        type: MessageTypeSchema.describe("Message type; use 'chat' for free-form text"),
        runId: z.string().optional().describe('Run this message belongs to, if any'),
        payload: z.unknown().describe('JSON payload; for chat use { "text": "..." }'),
      },
    },
    ({ to, type, runId, payload }) => {
      if (to === ctx.role) {
        return errorResult(`cannot post a message to your own role (${ctx.role})`);
      }
      if (runId !== undefined && !ctx.db.getRun(runId)) {
        return errorResult(`unknown run: ${runId}`);
      }
      const message = ctx.db.insertMessage({
        from: ctx.role,
        to,
        type,
        runId: runId ?? null,
        payload: payload ?? null,
      });
      ctx.events.messageFor(to);
      return jsonResult({ id: message.id });
    },
  );

  server.registerTool(
    'ack',
    {
      description:
        'Acknowledge messages you have handled so they stop appearing in your inbox. ' +
        'Only messages addressed to your role are affected; other ids are reported as ignored.',
      inputSchema: {
        ids: z.array(z.number().int().positive()).min(1).describe('Message ids to acknowledge'),
      },
    },
    ({ ids }) => {
      const acked: number[] = [];
      const ignored: number[] = [];
      for (const id of ids) {
        (ctx.db.ackMessage(id, ctx.role) ? acked : ignored).push(id);
      }
      return jsonResult({ acked, ignored });
    },
  );
}
