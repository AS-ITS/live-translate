import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { RELAY_PROTOCOL_VERSION, RELAY_STAGES, assertCuePacket, assertDeliveryStage, createRelayPacket, meetingChannel } from '../../src/relay/protocol.js';
import { RedisRelayBus } from '../../server/relay/relayBus.js';

test('relay protocol uses one monotonic sequence namespace for append and update', () => {
  const append = createRelayPacket('cue.append', { meetingId: 'm-1', event: { sequence: 1, cueId: 'cue-1' } });
  const update = createRelayPacket('cue.update', { meetingId: 'm-1', event: { sequence: 2, cueId: 'cue-1' } });
  assert.equal(append.protocol, RELAY_PROTOCOL_VERSION);
  assert.doesNotThrow(() => assertCuePacket(append));
  assert.doesNotThrow(() => assertCuePacket(update));
  assert.throws(() => assertCuePacket({ ...update, event: { sequence: 0 } }), /positive/);
  assert.equal(meetingChannel('m-1'), 'subtitle-relay:m-1');
});

test('relay stages keep forwarding, device durability, and viewer cursor distinct', () => {
  assert.equal(assertDeliveryStage(RELAY_STAGES.relayForwarded), 'relay_forwarded');
  assert.equal(assertDeliveryStage(RELAY_STAGES.devicePendingDurable), 'device_pending_durable');
  assert.equal(assertDeliveryStage(RELAY_STAGES.deviceApplied), 'device_applied');
  assert.equal(assertDeliveryStage(RELAY_STAGES.viewerCursor), 'viewer_cursor');
  assert.throws(() => assertDeliveryStage('durable'), /Unknown/);
});

test('Redis adapter constructs distinct publisher and dedicated subscriber for rediss URLs', async () => {
  class FakeRedis extends EventEmitter {
    constructor(url) { super(); this.url = url; this.subscribed = []; }
    async publish(channel, raw) { this.published = { channel, raw }; }
    async subscribe(channel) { this.subscribed.push(channel); }
    async unsubscribe(channel) { this.unsubscribed = channel; }
    async quit() { this.closed = true; }
  }
  const bus = new RedisRelayBus({ redisUrl: 'rediss://relay.example.test:6380', RedisClass: FakeRedis, logger: { warn() {} } });
  assert.notEqual(bus.publisher, bus.subscriber);
  assert.equal(bus.publisher.url, 'rediss://relay.example.test:6380');
  let received;
  const unsubscribe = await bus.subscribe('subtitle-relay:m-1', (packet) => { received = packet; });
  bus.subscriber.emit('message', 'subtitle-relay:m-1', JSON.stringify({ type: 'cue.append' }));
  assert.deepEqual(received, { type: 'cue.append' });
  await unsubscribe();
  await bus.close();
  assert.equal(bus.subscriber.closed, true);
});
