import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTestBus, type TestBus, textOf } from '../test-helpers.js';
import { resolveWaitSeconds } from './inbox.js';

type InboxResult = { messages: { id: number; from: string; payload: unknown }[] };

describe('resolveWaitSeconds', () => {
  it('defaults to 30 seconds', () => {
    expect(resolveWaitSeconds(undefined, 45)).toBe(30);
  });

  it('clamps to the configured maximum', () => {
    expect(resolveWaitSeconds(100, 45)).toBe(45);
  });

  it('keeps 0 (no wait) and clamps negatives to 0', () => {
    expect(resolveWaitSeconds(0, 45)).toBe(0);
    expect(resolveWaitSeconds(-5, 45)).toBe(0);
  });

  it('caps the default too when the maximum is lower', () => {
    expect(resolveWaitSeconds(undefined, 10)).toBe(10);
  });
});

describe('inbox tool', () => {
  let bus: TestBus;

  beforeEach(async () => {
    bus = await startTestBus();
  });

  afterEach(async () => {
    await bus.close();
  });

  const inbox = async (role: 'orchestrator' | 'implementer' | 'reviewer', waitSeconds?: number) => {
    const client = await bus.connect(role);
    const result = await client.callTool({ name: 'inbox', arguments: { waitSeconds } });
    return JSON.parse(textOf(result)) as InboxResult;
  };

  it('returns pending messages immediately, oldest first, without acking them', async () => {
    bus.db.insertMessage({ from: 'orchestrator', to: 'implementer', type: 'chat', payload: 1 });
    bus.db.insertMessage({ from: 'reviewer', to: 'implementer', type: 'chat', payload: 2 });
    const started = Date.now();
    const first = await inbox('implementer', 30);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(first.messages.map((m) => m.payload)).toEqual([1, 2]);
    expect((await inbox('implementer', 0)).messages).toHaveLength(2);
  });

  it('returns at most 20 messages per call', async () => {
    for (let i = 0; i < 25; i++) {
      bus.db.insertMessage({ from: 'orchestrator', to: 'implementer', type: 'chat', payload: i });
    }
    expect((await inbox('implementer', 0)).messages).toHaveLength(20);
  });

  it('returns an empty list immediately when waitSeconds is 0', async () => {
    expect(await inbox('reviewer', 0)).toEqual({ messages: [] });
  });

  it('wakes up quickly when a matching message is posted', async () => {
    const client = await bus.connect('reviewer');
    const started = Date.now();
    const waiting = client.callTool({ name: 'inbox', arguments: { waitSeconds: 10 } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(bus.events.listenerCountFor('reviewer')).toBe(1);
    const orchestrator = await bus.connect('orchestrator');
    await orchestrator.callTool({
      name: 'post',
      arguments: { to: 'reviewer', type: 'chat', payload: 'hello' },
    });
    const result = JSON.parse(textOf(await waiting)) as InboxResult;
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.messages).toMatchObject([{ from: 'orchestrator', payload: 'hello' }]);
    expect(bus.events.listenerCountFor('reviewer')).toBe(0);
  });

  it('is not woken by messages for another role', async () => {
    const client = await bus.connect('reviewer');
    const waiting = client.callTool({ name: 'inbox', arguments: { waitSeconds: 0.3 } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    bus.db.insertMessage({ from: 'reviewer', to: 'implementer', type: 'chat', payload: 'x' });
    bus.events.messageFor('implementer');
    const started = Date.now();
    const result = JSON.parse(textOf(await waiting)) as InboxResult;
    expect(result.messages).toEqual([]);
    expect(Date.now() - started).toBeGreaterThan(150);
  });

  it('returns an empty list after the timeout', async () => {
    const started = Date.now();
    expect(await inbox('orchestrator', 0.2)).toEqual({ messages: [] });
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
  });

  it('leaves no listeners behind after 100 sequential timeouts', async () => {
    const client = await bus.connect('implementer');
    for (let i = 0; i < 100; i++) {
      await client.callTool({ name: 'inbox', arguments: { waitSeconds: 0.005 } });
    }
    expect(bus.events.listenerCountFor('implementer')).toBe(0);
  });

  it('releases its listener when the client cancels a waiting call', async () => {
    const client = await bus.connect('implementer');
    const controller = new AbortController();
    const waiting = client
      .callTool({ name: 'inbox', arguments: { waitSeconds: 30 } }, undefined, {
        signal: controller.signal,
      })
      .catch(() => 'aborted');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(bus.events.listenerCountFor('implementer')).toBe(1);
    controller.abort();
    expect(await waiting).toBe('aborted');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(bus.events.listenerCountFor('implementer')).toBe(0);
  });

  describe('agent addressing', () => {
    const post = (client: Awaited<ReturnType<TestBus['connect']>>, to: string, payload: unknown) =>
      client.callTool({ name: 'post', arguments: { to, type: 'chat', payload } });

    it('shows each implementer its own messages plus role messages, never the other agent’s', async () => {
      const a = await bus.connect('implementer', 'impl-a');
      const b = await bus.connect('implementer', 'impl-b');
      const orchestrator = await bus.connect('orchestrator');
      await post(orchestrator, 'impl-a', 'for-a');
      await post(orchestrator, 'impl-b', 'for-b');
      await post(orchestrator, 'implementer', 'for-role');
      const read = async (c: typeof a) =>
        (
          JSON.parse(
            textOf(await c.callTool({ name: 'inbox', arguments: { waitSeconds: 0 } })),
          ) as InboxResult
        ).messages.map((m) => m.payload);
      expect(await read(a)).toEqual(['for-a', 'for-role']);
      expect(await read(b)).toEqual(['for-b', 'for-role']);
    });

    it('wakes a waiting agent for a message addressed to its id, and not for another agent', async () => {
      const a = await bus.connect('implementer', 'impl-a');
      await bus.connect('implementer', 'impl-b');
      const orchestrator = await bus.connect('orchestrator');
      const waiting = a.callTool({ name: 'inbox', arguments: { waitSeconds: 10 } });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(bus.events.listenerCountForAgent('impl-a')).toBe(1);
      await post(orchestrator, 'impl-b', 'not-for-a');
      await post(orchestrator, 'impl-a', 'for-a');
      const result = JSON.parse(textOf(await waiting)) as InboxResult;
      expect(result.messages).toMatchObject([
        { payload: 'for-a', to: 'implementer', toAgent: 'impl-a' },
      ]);
      expect(bus.events.listenerCountForAgent('impl-a')).toBe(0);
      expect(bus.events.listenerCountFor('implementer')).toBe(0);
    });
  });
});
