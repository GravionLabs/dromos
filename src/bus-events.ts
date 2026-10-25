import { EventEmitter } from 'node:events';
import type { EventRecord } from './db.js';
import type { Role } from './schemas.js';

/** In-process signal used to wake up `inbox` long-polls when a message arrives. */
export class BusEvents extends EventEmitter {
  constructor() {
    super();
    // One waiting inbox per connected agent session; several sessions per role are allowed.
    this.setMaxListeners(0);
  }

  static channel(role: Role): string {
    return `message:${role}`;
  }

  messageFor(role: Role): void {
    this.emit(BusEvents.channel(role));
  }

  onMessageFor(role: Role, listener: () => void): () => void {
    const channel = BusEvents.channel(role);
    this.on(channel, listener);
    return () => this.off(channel, listener);
  }

  static agentChannel(agentId: string): string {
    return `message:agent:${agentId}`;
  }

  messageForAgent(agentId: string): void {
    this.emit(BusEvents.agentChannel(agentId));
  }

  onMessageForAgent(agentId: string, listener: () => void): () => void {
    const channel = BusEvents.agentChannel(agentId);
    this.on(channel, listener);
    return () => this.off(channel, listener);
  }

  listenerCountForAgent(agentId: string): number {
    return this.listenerCount(BusEvents.agentChannel(agentId));
  }

  listenerCountFor(role: Role): number {
    return this.listenerCount(BusEvents.channel(role));
  }

  static readonly EVENT_CHANNEL = 'event';

  /** Broadcast a stored event row to every stream subscriber. */
  publishEvent(event: EventRecord): void {
    this.emit(BusEvents.EVENT_CHANNEL, event);
  }

  onEvent(listener: (event: EventRecord) => void): () => void {
    this.on(BusEvents.EVENT_CHANNEL, listener);
    return () => this.off(BusEvents.EVENT_CHANNEL, listener);
  }

  eventListenerCount(): number {
    return this.listenerCount(BusEvents.EVENT_CHANNEL);
  }
}
