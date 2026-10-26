import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTestBus, type TestBus, textOf, validTask } from '../test-helpers.js';

describe('messaging tools', () => {
  let bus: TestBus;

  beforeEach(async () => {
    bus = await startTestBus();
  });

  afterEach(async () => {
    await bus.close();
  });

  describe('post', () => {
    it('persists the message from the caller and returns its id', async () => {
      const implementer = await bus.connect('implementer');
      const result = await implementer.callTool({
        name: 'post',
        arguments: { to: 'orchestrator', type: 'chat', payload: { text: 'hi' } },
      });
      const { id } = JSON.parse(textOf(result)) as { id: number };
      expect(id).toBe(1);
      expect(bus.db.listUnacked('orchestrator')).toMatchObject([
        { id, from: 'implementer', to: 'orchestrator', type: 'chat', payload: { text: 'hi' } },
      ]);
    });

    it('rejects a task without objective and stores nothing', async () => {
      const { objective: _o, ...payload } = validTask('r');
      const orchestrator = await bus.connect('orchestrator');
      const result = await orchestrator.callTool({
        name: 'post',
        arguments: { to: 'implementer', type: 'task', payload },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('invalid task payload');
      expect(textOf(result)).toContain('objective');
      expect(bus.db.listUnacked('implementer')).toEqual([]);
    });

    it('rejects a task without ownership, with empty ownership or null payload', async () => {
      const { ownership: _o, ...payload } = validTask('r');
      const orchestrator = await bus.connect('orchestrator');
      for (const bad of [payload, { ...validTask('r'), ownership: [] }, null]) {
        const result = await orchestrator.callTool({
          name: 'post',
          arguments: { to: 'implementer', type: 'task', payload: bad },
        });
        expect(result.isError).toBe(true);
      }
      expect(bus.db.listUnacked('implementer')).toEqual([]);
    });

    it('stores a valid task payload', async () => {
      const orchestrator = await bus.connect('orchestrator');
      const result = await orchestrator.callTool({
        name: 'post',
        arguments: { to: 'implementer', type: 'task', payload: validTask('r') },
      });
      expect(result.isError).toBeFalsy();
      expect(bus.db.listUnacked('implementer')).toMatchObject([{ payload: validTask('r') }]);
    });

    it('logs a MESSAGE line with sender, receiver, type and run', async () => {
      bus.db.insertRun({
        id: 'run-1-1',
        repo: 'o/r',
        repoPath: '/r',
        issueNumber: 1,
        issueTitle: 't',
        baseBranch: 'main',
        branch: 'b',
        worktreePath: '/w',
      });
      const orchestrator = await bus.connect('orchestrator');
      await orchestrator.callTool({
        name: 'post',
        arguments: {
          to: 'implementer',
          type: 'task',
          runId: 'run-1-1',
          payload: validTask('run-1-1'),
        },
      });
      await orchestrator.callTool({
        name: 'post',
        arguments: { to: 'reviewer', type: 'chat', payload: 'x' },
      });
      const log = bus.readLog();
      expect(log).toContain('orchestrator -> implementer [task] run-1-1');
      expect(log).toMatch(/orchestrator -> reviewer \[chat\]\n$/);
    });

    it('wakes listeners of the addressed role only', async () => {
      const seen: string[] = [];
      bus.events.onMessageFor('orchestrator', () => seen.push('orchestrator'));
      bus.events.onMessageFor('reviewer', () => seen.push('reviewer'));
      const implementer = await bus.connect('implementer');
      await implementer.callTool({
        name: 'post',
        arguments: { to: 'orchestrator', type: 'chat', payload: null },
      });
      expect(seen).toEqual(['orchestrator']);
    });

    it('rejects posting to your own role', async () => {
      const reviewer = await bus.connect('reviewer');
      const result = await reviewer.callTool({
        name: 'post',
        arguments: { to: 'reviewer', type: 'chat', payload: 'x' },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('own role');
      expect(bus.db.listUnacked('reviewer')).toEqual([]);
    });

    it('addresses a registered agent id and records sender and recipient agents', async () => {
      const impl = await bus.connect('implementer', 'impl-a');
      const orchestrator = await bus.connect('orchestrator', 'orch-1');
      const result = await orchestrator.callTool({
        name: 'post',
        arguments: { to: 'impl-a', type: 'chat', payload: 'x' },
      });
      expect(result.isError).toBeFalsy();
      expect(bus.db.listUnacked('implementer')).toEqual([]);
      expect(bus.db.listUnacked('implementer', 20, 'impl-a')).toMatchObject([
        { from: 'orchestrator', to: 'implementer', fromAgent: 'orch-1', toAgent: 'impl-a' },
      ]);
      expect(impl).toBeDefined();
    });

    it('rejects an unknown agent id and posting to yourself by id', async () => {
      const impl = await bus.connect('implementer', 'impl-a');
      const unknown = await impl.callTool({
        name: 'post',
        arguments: { to: 'ghost', type: 'chat', payload: 'x' },
      });
      const self = await impl.callTool({
        name: 'post',
        arguments: { to: 'impl-a', type: 'chat', payload: 'x' },
      });
      expect(unknown.isError).toBe(true);
      expect(textOf(unknown)).toContain('unknown recipient');
      expect(self.isError).toBe(true);
    });

    it('rejects an unknown run id', async () => {
      const client = await bus.connect('orchestrator');
      const result = await client.callTool({
        name: 'post',
        arguments: { to: 'implementer', type: 'chat', runId: 'nope', payload: 'x' },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('unknown run');
    });

    it('rejects an invalid message type or role (schema validation)', async () => {
      const client = await bus.connect('orchestrator');
      const badType = await client.callTool({
        name: 'post',
        arguments: { to: 'implementer', type: 'shout', payload: 'x' },
      });
      const badRole = await client.callTool({
        name: 'post',
        arguments: { to: 'admin', type: 'chat', payload: 'x' },
      });
      expect(badType.isError).toBe(true);
      expect(badRole.isError).toBe(true);
    });
  });

  describe('ack', () => {
    async function seed() {
      const implementer = await bus.connect('implementer');
      const { id } = JSON.parse(
        textOf(
          await implementer.callTool({
            name: 'post',
            arguments: { to: 'orchestrator', type: 'chat', payload: 'x' },
          }),
        ),
      ) as { id: number };
      return id;
    }

    it('acks a message addressed to the caller', async () => {
      const id = await seed();
      const orchestrator = await bus.connect('orchestrator');
      const result = await orchestrator.callTool({ name: 'ack', arguments: { ids: [id] } });
      expect(JSON.parse(textOf(result))).toEqual({ acked: [id], ignored: [] });
      expect(bus.db.listUnacked('orchestrator')).toEqual([]);
    });

    it("ignores another role's messages and unknown ids", async () => {
      const id = await seed();
      const reviewer = await bus.connect('reviewer');
      const result = await reviewer.callTool({ name: 'ack', arguments: { ids: [id, 999] } });
      expect(JSON.parse(textOf(result))).toEqual({ acked: [], ignored: [id, 999] });
      expect(bus.db.listUnacked('orchestrator')).toHaveLength(1);
    });

    it('does not let another agent of the same role ack an agent-addressed message', async () => {
      await bus.connect('implementer', 'impl-a');
      const b = await bus.connect('implementer', 'impl-b');
      const orchestrator = await bus.connect('orchestrator');
      const { id } = JSON.parse(
        textOf(
          await orchestrator.callTool({
            name: 'post',
            arguments: { to: 'impl-a', type: 'chat', payload: 'x' },
          }),
        ),
      ) as { id: number };
      const result = await b.callTool({ name: 'ack', arguments: { ids: [id] } });
      expect(JSON.parse(textOf(result))).toEqual({ acked: [], ignored: [id] });
      expect(bus.db.listUnacked('implementer', 20, 'impl-a')).toHaveLength(1);
    });

    it('rejects an empty id list', async () => {
      const client = await bus.connect('orchestrator');
      const result = await client.callTool({ name: 'ack', arguments: { ids: [] } });
      expect(result.isError).toBe(true);
    });
  });
});
