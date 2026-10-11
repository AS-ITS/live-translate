import assert from 'node:assert/strict';
import test from 'node:test';
import { createRedisSignalingStore } from '../../server/webrtc/signalingRoute.js';

class FakeRedis {
  constructor(clock) {
    this.clock = clock;
    this.values = new Map();
    this.members = new Map();
    this.sorted = new Map();
  }

  read(key) {
    const entry = this.values.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.clock()) { this.values.delete(key); return null; }
    return entry.value;
  }

  async get(key) { return this.read(key); }
  async set(key, value, mode, ttl) {
    this.values.set(key, { value, expiresAt: this.clock() + (mode === 'PX' ? Number(ttl) : 60_000) });
    return 'OK';
  }
  async del(key) { this.values.delete(key); return 1; }
  async incr(key) {
    const value = Number(this.read(key) || 0) + 1;
    await this.set(key, String(value), 'PX', 60_000);
    return value;
  }
  async pexpire(key, ttl) {
    const value = this.read(key);
    if (value !== null) await this.set(key, value, 'PX', ttl);
    return 1;
  }
  async zadd(key, score, value) {
    const entries = this.sorted.get(key) || [];
    entries.push({ score: Number(score), value });
    entries.sort((left, right) => left.score - right.score);
    this.sorted.set(key, entries);
    return 1;
  }
  async zremrangebyrank(key, start, stop) {
    const entries = this.sorted.get(key) || [];
    const end = stop < 0 ? entries.length + stop : stop;
    entries.splice(start, Math.max(0, end - start + 1));
    return 1;
  }
  async zrangebyscore(key, min, max, _limit, offset, count) {
    const upper = max === '+inf' ? Infinity : Number(max);
    return (this.sorted.get(key) || [])
      .filter(({ score }) => score >= Number(min) && score <= upper)
      .slice(Number(offset), Number(offset) + Number(count))
      .map(({ value }) => value);
  }
  async mget(keys) { return keys.map((key) => this.read(key)); }
  async eval(script, count, ...args) {
    assert.equal(script.includes('webrtc-route-join'), true);
    assert.equal(count, 4);
    const [revokedKey, participantKey, membersKey, cursorKey, participantPrefix,
      participantRaw, ttl, cap, participantId] = args;
    if (this.read(revokedKey)) return ['revoked'];
    const existing = this.read(participantKey);
    const members = this.members.get(membersKey) || new Set();
    if (existing) {
      await this.set(participantKey, participantRaw, 'PX', ttl);
      members.add(participantId);
      this.members.set(membersKey, members);
      await this.pexpire(cursorKey, ttl);
      return ['existing', participantRaw];
    }
    for (const member of members) if (!this.read(`${participantPrefix}${member}`)) members.delete(member);
    if (members.size >= Number(cap)) return ['cap'];
    await this.set(participantKey, participantRaw, 'PX', ttl);
    members.add(participantId);
    this.members.set(membersKey, members);
    await this.pexpire(cursorKey, ttl);
    return ['joined', participantRaw];
  }
}

test('Recorder remains discoverable for a first Viewer after sixty simulated minutes', async () => {
  let now = 0;
  const participantTtlMs = 60_000;
  const store = createRedisSignalingStore({
    redis: new FakeRedis(() => now),
    clock: () => now,
    participantTtlMs,
    messageTtlMs: 30_000,
    maxParticipantsPerMeeting: 6,
    maxMessageBytes: 64 * 1024,
  });
  const device = { id: 'device-1', role: 'device', userId: 'user-1' };

  for (let heartbeat = 0; heartbeat < 120; heartbeat += 1) {
    await store.join({
      meetingId: 'meeting-1', participantId: device.id, ttlMs: participantTtlMs,
      participant: { ...device, expiresAt: now + participantTtlMs },
    });
    now += participantTtlMs / 2;
  }

  await store.join({
    meetingId: 'meeting-1', participantId: 'viewer-1', ttlMs: participantTtlMs,
    participant: { id: 'viewer-1', role: 'viewer', shareId: 'share-1', expiresAt: now + participantTtlMs },
  });
  await store.append({
    meetingId: 'meeting-1', participantId: 'viewer-1', type: 'viewer-ready', payload: {},
    negotiationId: 'negotiation-1',
  });
  const ready = await store.receive({ meetingId: 'meeting-1', participantId: device.id, after: 0 });
  assert.deepEqual(ready.messages.map(({ type, participantId, negotiationId }) => (
    { type, participantId, negotiationId }
  )), [{ type: 'viewer-ready', participantId: 'viewer-1', negotiationId: 'negotiation-1' }]);

  await store.append({
    meetingId: 'meeting-1', participantId: device.id, type: 'offer', payload: { type: 'offer', sdp: 'test' },
    targetParticipantId: 'viewer-1', negotiationId: 'negotiation-1',
  });
  const offer = await store.receive({ meetingId: 'meeting-1', participantId: 'viewer-1', after: 0 });
  assert.deepEqual(offer.messages.map(({ type, targetParticipantId, negotiationId }) => (
    { type, targetParticipantId, negotiationId }
  )), [{ type: 'offer', targetParticipantId: 'viewer-1', negotiationId: 'negotiation-1' }]);
});
