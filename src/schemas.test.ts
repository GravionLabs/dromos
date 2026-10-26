import { describe, expect, it } from 'vitest';
import {
  FindingSchema,
  GateResultSchema,
  HookEventSchema,
  MessageSchema,
  parseTaskPayload,
  ReviewSchema,
  RoleSchema,
  TaskMessageSchema,
  TaskPayloadSchema,
} from './schemas.js';

describe('schemas', () => {
  describe('RoleSchema', () => {
    it('accepts the three roles', () => {
      for (const role of ['orchestrator', 'implementer', 'reviewer']) {
        expect(RoleSchema.parse(role)).toBe(role);
      }
    });

    it('rejects unknown roles', () => {
      expect(RoleSchema.safeParse('admin').success).toBe(false);
    });
  });

  describe('FindingSchema', () => {
    it('accepts a finding with a line number', () => {
      const finding = { severity: 'critical', file: 'src/a.ts', line: 3, summary: 'bug' };
      expect(FindingSchema.parse(finding)).toEqual(finding);
    });

    it('accepts a finding without a line number', () => {
      expect(
        FindingSchema.safeParse({ severity: 'suggestion', file: 'a', summary: 's' }).success,
      ).toBe(true);
    });

    it('rejects an empty file', () => {
      expect(
        FindingSchema.safeParse({ severity: 'important', file: '', summary: 's' }).success,
      ).toBe(false);
    });

    it('rejects line 0', () => {
      expect(
        FindingSchema.safeParse({ severity: 'important', file: 'a', line: 0, summary: 's' })
          .success,
      ).toBe(false);
    });

    it('rejects a summary longer than 2000 characters', () => {
      expect(
        FindingSchema.safeParse({ severity: 'important', file: 'a', summary: 'x'.repeat(2001) })
          .success,
      ).toBe(false);
    });
  });

  describe('ReviewSchema', () => {
    it('defaults findings to an empty list', () => {
      expect(ReviewSchema.parse({ verdict: 'approve', summary: 'looks good' })).toEqual({
        verdict: 'approve',
        summary: 'looks good',
        findings: [],
      });
    });

    it('rejects an unknown verdict', () => {
      expect(ReviewSchema.safeParse({ verdict: 'maybe', summary: 's' }).success).toBe(false);
    });

    it('rejects more than 100 findings', () => {
      const findings = Array.from({ length: 101 }, () => ({
        severity: 'suggestion',
        file: 'a',
        summary: 's',
      }));
      expect(ReviewSchema.safeParse({ verdict: 'changes', summary: 's', findings }).success).toBe(
        false,
      );
    });
  });

  describe('HookEventSchema', () => {
    it('accepts an event with a free-text model', () => {
      const event = { role: 'reviewer', cli: 'copilot', state: 'idle', model: 'GPT-Luna' };
      expect(HookEventSchema.parse(event)).toEqual(event);
    });

    it('rejects an unknown state', () => {
      expect(
        HookEventSchema.safeParse({ role: 'reviewer', cli: 'claude', state: 'sleeping' }).success,
      ).toBe(false);
    });

    it('rejects an unknown cli', () => {
      expect(
        HookEventSchema.safeParse({ role: 'reviewer', cli: 'vim', state: 'idle' }).success,
      ).toBe(false);
    });
  });

  describe('TaskPayloadSchema', () => {
    const full = {
      objective: 'Do it',
      constraints: ['c'],
      ownership: ['src/**'],
      outputFormat: 'commits',
      editsAllowed: true,
      validation: ['pnpm test'],
      forbidden: ['push'],
      issue: 130,
      runId: 'run-130-1',
    };

    it('accepts a full payload and keeps extra keys', () => {
      expect(TaskPayloadSchema.parse({ ...full, branch: 'b' })).toEqual({ ...full, branch: 'b' });
    });

    it('rejects a missing objective', () => {
      const { objective: _o, ...rest } = full;
      expect(parseTaskPayload(rest).success).toBe(false);
    });

    it('rejects missing or empty ownership', () => {
      const { ownership: _o, ...rest } = full;
      expect(parseTaskPayload(rest).success).toBe(false);
      expect(parseTaskPayload({ ...full, ownership: [] }).success).toBe(false);
    });

    it('rejects wrong types', () => {
      expect(parseTaskPayload({ ...full, editsAllowed: 'yes' }).success).toBe(false);
      expect(parseTaskPayload({ ...full, issue: '130' }).success).toBe(false);
      expect(parseTaskPayload({ ...full, issue: 0 }).success).toBe(false);
      expect(parseTaskPayload(null).success).toBe(false);
    });

    it('TaskMessageSchema requires the typed payload only for task', () => {
      const message = {
        id: 1,
        from: 'orchestrator',
        to: 'implementer',
        type: 'task',
        runId: null,
        payload: full,
        createdAt: '2026-09-24T05:00:00.000Z',
        ackedAt: null,
      };
      expect(TaskMessageSchema.safeParse(message).success).toBe(true);
      expect(TaskMessageSchema.safeParse({ ...message, payload: null }).success).toBe(false);
      expect(TaskMessageSchema.safeParse({ ...message, type: 'chat' }).success).toBe(false);
    });
  });

  describe('MessageSchema', () => {
    it('accepts a stored message', () => {
      const message = {
        id: 1,
        from: 'orchestrator',
        to: 'implementer',
        type: 'task',
        runId: null,
        payload: { issue: 1 },
        createdAt: '2026-09-24T05:00:00.000Z',
        ackedAt: null,
      };
      expect(MessageSchema.parse(message)).toEqual(message);
    });

    it('accepts a message with agent ids', () => {
      const message = {
        id: 2,
        from: 'orchestrator',
        to: 'implementer',
        fromAgent: 'orch-1',
        toAgent: 'impl-a',
        type: 'chat',
        runId: null,
        payload: null,
        createdAt: '2026-09-24T05:00:00.000Z',
        ackedAt: null,
      };
      expect(MessageSchema.parse(message)).toEqual(message);
    });

    it('rejects a non-ISO timestamp', () => {
      expect(
        MessageSchema.safeParse({
          id: 1,
          from: 'orchestrator',
          to: 'implementer',
          type: 'task',
          runId: null,
          payload: null,
          createdAt: 'yesterday',
          ackedAt: null,
        }).success,
      ).toBe(false);
    });
  });

  describe('GateResultSchema', () => {
    it('accepts a failed gate', () => {
      const gate = {
        passed: false,
        steps: [
          { name: 'test', command: 'pnpm test', exitCode: 1, durationMs: 10, outputTail: 'x' },
        ],
      };
      expect(GateResultSchema.parse(gate)).toEqual(gate);
    });
  });
});
