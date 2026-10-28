import { describe, expect, it } from 'vitest';
import { BusEvents } from './bus-events.js';
import type { EventRecord } from './db.js';

const event = (id: number): EventRecord => ({
  id,
  role: 'implementer',
  kind: 'hook:idle',
  data: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  agentId: null,
  issue: null,
  runId: null,
  repo: null,
});

describe('BusEvents event channel', () => {
  it('delivers a published event to every subscriber', () => {
    const bus = new BusEvents();
    const a: EventRecord[] = [];
    const b: EventRecord[] = [];
    bus.onEvent((e) => a.push(e));
    bus.onEvent((e) => b.push(e));
    bus.publishEvent(event(1));
    expect(a).toEqual([event(1)]);
    expect(b).toEqual([event(1)]);
    expect(bus.eventListenerCount()).toBe(2);
  });

  it('stops delivering after unsubscribe', () => {
    const bus = new BusEvents();
    const seen: number[] = [];
    const off = bus.onEvent((e) => seen.push(e.id));
    bus.publishEvent(event(1));
    off();
    bus.publishEvent(event(2));
    expect(seen).toEqual([1]);
    expect(bus.eventListenerCount()).toBe(0);
  });

  it('does not wake message listeners', () => {
    const bus = new BusEvents();
    let woke = false;
    bus.onMessageFor('implementer', () => {
      woke = true;
    });
    bus.publishEvent(event(1));
    expect(woke).toBe(false);
  });
});
