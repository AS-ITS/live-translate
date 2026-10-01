import { EventEmitter } from 'node:events';

export class InMemoryRelayStore {
  constructor({ now = () => Date.now() } = {}) { this.now = now; this.values = new Map(); }
  async get(key) {
    const entry = this.values.get(key);
    if (!entry) return null;
    if (entry.expiresAt && entry.expiresAt <= this.now()) { this.values.delete(key); return null; }
    return structuredClone(entry.value);
  }
  async set(key, value, ttlMs) { this.values.set(key, { value: structuredClone(value), expiresAt: ttlMs ? this.now() + ttlMs : null }); }
  async delete(key) { this.values.delete(key); }
}

export class InMemoryRelayShareStateStore {
  constructor() { this.states = new Map(); }
  async setStatus(meetingId, status) { this.states.set(meetingId, { meetingId, status }); }
  async assertActive(meetingId) {
    const state = this.states.get(meetingId);
    if (!state || state.status !== 'active') throw new Error('Relay share is stopped or revoked.');
    return state;
  }
}

export class InMemoryRelayBroker {
  constructor() { this.subscriptions = new Map(); }
  add(channel, subscription) { (this.subscriptions.get(channel) || this.subscriptions.set(channel, new Set()).get(channel)).add(subscription); }
  remove(channel, subscription) { this.subscriptions.get(channel)?.delete(subscription); }
  publish(channel, packet) { for (const subscription of [...(this.subscriptions.get(channel) || [])]) subscription.onPacket(structuredClone(packet)); }
  lose(clientId) {
    for (const [channel, subscriptions] of this.subscriptions) {
      for (const subscription of [...subscriptions]) {
        if (subscription.clientId === clientId) { subscriptions.delete(subscription); subscription.onLoss(); }
      }
      if (subscriptions.size === 0) this.subscriptions.delete(channel);
    }
  }
}

export class InMemoryRelayBus {
  constructor({ broker, clientId }) { this.broker = broker; this.clientId = clientId; }
  async publish(channel, packet) { this.broker.publish(channel, packet); }
  async subscribe(channel, onPacket, onLoss) {
    const subscription = { clientId: this.clientId, onPacket, onLoss };
    this.broker.add(channel, subscription);
    return async () => this.broker.remove(channel, subscription);
  }
}

export class FakeWebSocket extends EventEmitter {
  constructor() { super(); this.OPEN = 1; this.readyState = this.OPEN; this.sent = []; }
  send(value) { const packet = typeof value === 'string' ? JSON.parse(value) : value; this.sent.push(packet); this.emit('sent', packet); }
  clientSend(packet) { this.emit('message', JSON.stringify(packet)); }
  close(code = 1000, reason = '') { if (this.readyState !== this.OPEN) return; this.readyState = 3; this.emit('close', code, reason); }
}
