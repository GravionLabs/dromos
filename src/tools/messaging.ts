import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolContext } from '../context.js';
import { MessageTypeSchema, parseTaskPayload, type Role, RoleSchema } from '../schemas.js';
import { errorResult, jsonResult } from './util.js';

export function registerMessagingTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'post',
    {
      description:
        "Send a message to a role (all agents of that role) or to one agent by id. Use type 'chat' for free-form questions; " +
        'workflow messages (task, gate_result, review_request, review_result, notice) are ' +
        'normally created by the workflow tools, not by you.',
      inputSchema: {
        to: z.string().min(1).describe('Role or agent id that receives the message'),
        type: MessageTypeSchema.describe("Message type; use 'chat' for free-form text"),
        runId: z.string().optional().describe('Run this message belongs to, if any'),
        payload: z
          .unknown()
          .describe(
            'JSON payload; for chat use { "text": "..." }. For task it must contain objective, constraints, ownership (non-empty), ' +
              'outputFormat, editsAllowed, validation, forbidden, issue (number) and runId',
          ),
      },
    },
    ({ to, type, runId, payload }) => {
      if (to === ctx.role) {
        return errorResult(`cannot post a message to your own role (${ctx.role})`);
      }
      if (to === ctx.agentId) {
        return errorResult(`cannot post a message to yourself (${ctx.agentId})`);
      }
      const asRole = RoleSchema.safeParse(to);
      const recipient = asRole.success ? undefined : ctx.db.getAgent(to);
      if (!asRole.success && !recipient) {
        return errorResult(`unknown recipient: ${to} (not a role or a registered agent id)`);
      }
      const toRole: Role = asRole.success ? asRole.data : (recipient as { role: Role }).role;
      if (runId !== undefined && !ctx.db.getRun(runId)) {
        return errorResult(`unknown run: ${runId}`);
      }
      if (type === 'task') {
        const parsed = parseTaskPayload(payload);
        if (!parsed.success) {
          return errorResult(`invalid task payload: ${z.prettifyError(parsed.error)}`);
        }
      }
      const message = ctx.db.insertMessage({
        from: ctx.role,
        to: toRole,
        fromAgent: ctx.agentId,
        toAgent: recipient ? recipient.id : null,
        type,
        runId: runId ?? null,
        payload: payload ?? null,
      });
      ctx.log.logLine('MESSAGE', `${ctx.role} -> ${to} [${type}]${runId ? ` ${runId}` : ''}`);
      if (recipient) {
        ctx.events.messageForAgent(recipient.id);
      } else {
        ctx.events.messageFor(toRole);
      }
      return jsonResult({ id: message.id });
    },
  );

  server.registerTool(
    'ack',
    {
      description:
        'Acknowledge messages you have handled so they stop appearing in your inbox. ' +
        'Only messages addressed to your role or agent id are affected; other ids are reported as ignored.',
      inputSchema: {
        ids: z.array(z.number().int().positive()).min(1).describe('Message ids to acknowledge'),
      },
    },
    ({ ids }) => {
      const acked: number[] = [];
      const ignored: number[] = [];
      for (const id of ids) {
        (ctx.db.ackMessage(id, ctx.role, ctx.agentId) ? acked : ignored).push(id);
      }
      return jsonResult({ acked, ignored });
    },
  );
}
