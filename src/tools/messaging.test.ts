import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTestBus, type TestBus, textOf } from '../test-helpers.js';

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

    it('rejects an empty id list', async () => {
      const client = await bus.connect('orchestrator');
      const result = await client.callTool({ name: 'ack', arguments: { ids: [] } });
      expect(result.isError).toBe(true);
    });
  });
});
