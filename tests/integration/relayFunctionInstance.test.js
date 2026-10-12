import test from 'node:test';
import assert from 'node:assert/strict';
import { RelayRegistry } from '../../server/relay/relayRegistry.js';
import { RelayFunctionInstance } from '../../server/relay/relayFunctionInstance.js';
import { FakeWebSocket, InMemoryRelayBroker, InMemoryRelayBus, InMemoryRelayShareStateStore, InMemoryRelayStore } from '../../server/relay/fakes.js';
import { createRelayPacket } from '../../src/relay/protocol.js';

function setup({ requestTimeoutMs = 20, maxRequestRetries = 2, generation = 1 } = {}) {
  const broker = new InMemoryRelayBroker();
  const store = new InMemoryRelayStore();
  const state = new InMemoryRelayShareStateStore();
  const registry = new RelayRegistry({ store, defaultTtlMs: 100 });
  const deviceInstance = new RelayFunctionInstance({ functionInstanceId: 'device-fn', bus: new InMemoryRelayBus({ broker, clientId: 'device-fn' }), registry, shareStateStore: state, requestTimeoutMs, maxRequestRetries, idFactory: idFactory('device') });
  const viewerInstance = new RelayFunctionInstance({ functionInstanceId: 'viewer-fn', bus: new InMemoryRelayBus({ broker, clientId: 'viewer-fn' }), registry, shareStateStore: state, requestTimeoutMs, maxRequestRetries, idFactory: idFactory('viewer') });
  return { broker, store, state, registry, deviceInstance, viewerInstance, generation };
}

async function connectDevice(ctx, history, { connectionId = 'device-1', generation = ctx.generation } = {}) {
  const socket = new FakeWebSocket();
  socket.on('sent', (packet) => {
    if (packet.type === 'snapshot.request') socket.clientSend(createRelayPacket('snapshot.response', { meetingId: packet.meetingId, requestId: packet.requestId, targetConnectionId: packet.viewerConnectionId, cursor: 0, cues: [] }));
    if (packet.type === 'replay.request') socket.clientSend(createRelayPacket('replay.response', { meetingId: packet.meetingId, requestId: packet.requestId, targetConnectionId: packet.viewerConnectionId, events: history.filter((event) => event.event.sequence > packet.afterSequence) }));
  });
  await ctx.deviceInstance.connectDevice({ deviceId: 'device-a', meetingId: 'meeting-a', connectionId, generation, socket });
  return socket;
}

async function connectViewer(ctx, connectionId = 'viewer-1') {
  const socket = new FakeWebSocket();
  await ctx.viewerInstance.connectViewer({ meetingId: 'meeting-a', connectionId, socket });
  await wait(15);
  return socket;
}

function cue(sequence, type = 'cue.append') { return createRelayPacket(type, { meetingId: 'meeting-a', event: { cueId: 'cue-1', sequence, translatedText: `v${sequence}` } }); }
function idFactory(prefix) { let value = 0; return () => `${prefix}-${++value}`; }
function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function delivered(socket) { return socket.sent.filter((packet) => packet.type === 'cue'); }

test('cross-instance snapshot handoff buffers a delayed cue.update and applies a continuous cursor', async () => {
  const ctx = setup(); await ctx.state.setStatus('meeting-a', 'active');
  const history = [cue(1), cue(2, 'cue.update')];
  const device = await connectDevice(ctx, history);
  const viewer = await connectViewer(ctx);
  device.clientSend(history[0]);
  device.clientSend(history[1]);
  await wait(5);
  assert.deepEqual(delivered(viewer).map((packet) => packet.event.sequence), [1, 2]);
  assert.equal(viewer.sent.find((packet) => packet.type === 'snapshot').cursor, 0);
  assert.equal(device.sent.find((packet) => packet.type === 'ack').stage, 'relay_forwarded');
  assert.equal(device.sent.filter((packet) => packet.type === 'viewer.cursor').at(-1).stage, 'viewer_cursor');
});

test('gap triggers device replay, and the viewer never advances over a missing sequence', async () => {
  const ctx = setup(); await ctx.state.setStatus('meeting-a', 'active');
  const history = [cue(1), cue(2, 'cue.update'), cue(3)];
  const device = await connectDevice(ctx, history);
  const viewer = await connectViewer(ctx);
  device.clientSend(history[0]);
  device.clientSend(history[2]);
  await wait(5);
  assert.deepEqual(delivered(viewer).map((packet) => packet.event.sequence), [1, 2, 3]);
  assert.ok(device.sent.some((packet) => packet.type === 'replay.request' && packet.afterSequence === 1));
});

test('subscription loss re-subscribes online viewer and recovers the gap from the device', async () => {
  const ctx = setup(); await ctx.state.setStatus('meeting-a', 'active');
  const history = [cue(1), cue(2), cue(3)];
  const device = await connectDevice(ctx, history);
  const viewer = await connectViewer(ctx);
  device.clientSend(history[0]);
  ctx.broker.lose('viewer-fn');
  await wait(0);
  device.clientSend(history[1]);
  device.clientSend(history[2]);
  await wait(0);
  assert.deepEqual(delivered(viewer).map((packet) => packet.event.sequence), [1, 2, 3]);
  assert.ok(device.sent.some((packet) => packet.type === 'replay.request'));
});

test('device durability stages are forwarded but do not claim local persistence from relay_forwarded', async () => {
  const ctx = setup(); await ctx.state.setStatus('meeting-a', 'active');
  const device = await connectDevice(ctx, []); const viewer = await connectViewer(ctx);
  device.clientSend(createRelayPacket('device.status', { meetingId: 'meeting-a', stage: 'device_pending_durable', sequence: 1 }));
  device.clientSend(createRelayPacket('device.status', { meetingId: 'meeting-a', stage: 'device_applied', sequence: 1 }));
  await wait(0);
  assert.deepEqual(viewer.sent.filter((packet) => packet.type === 'device.status').map((packet) => packet.stage), ['device_pending_durable', 'device_applied']);
});

test('stopped state rejects reconnect and replay, then closes existing viewers after a lost stop notification', async () => {
  const ctx = setup(); await ctx.state.setStatus('meeting-a', 'active');
  await connectDevice(ctx, []); const viewer = await connectViewer(ctx);
  const unsubscribe = ctx.viewerInstance.subscriptions.get('meeting-a');
  await unsubscribe();
  ctx.viewerInstance.subscriptions.delete('meeting-a'); // The function missed the stop notification before its subscription recovers.
  await ctx.deviceInstance.stopOrRevoke('meeting-a', 'stopped');
  await wait(0);
  await assert.rejects(() => ctx.viewerInstance.connectViewer({ meetingId: 'meeting-a', connectionId: 'viewer-2', socket: new FakeWebSocket() }), /stopped or revoked/);
  viewer.clientSend(createRelayPacket('replay.request', { meetingId: 'meeting-a', requestId: 'manual' }));
  await wait(0);
  assert.ok(viewer.sent.some((packet) => packet.code === 'relay_request_rejected'));
});

test('expired function registry entry rejects a stale replay and device redeploy generation replaces metadata', async () => {
  let now = 0;
  const broker = new InMemoryRelayBroker(); const store = new InMemoryRelayStore({ now: () => now }); const state = new InMemoryRelayShareStateStore(); await state.setStatus('meeting-a', 'active');
  const registry = new RelayRegistry({ store, now: () => now, defaultTtlMs: 5 });
  const one = new RelayFunctionInstance({ functionInstanceId: 'device-old', bus: new InMemoryRelayBus({ broker, clientId: 'device-old' }), registry, shareStateStore: state, idFactory: idFactory('old') });
  const two = new RelayFunctionInstance({ functionInstanceId: 'device-new', bus: new InMemoryRelayBus({ broker, clientId: 'device-new' }), registry, shareStateStore: state, idFactory: idFactory('new') });
  await one.connectDevice({ deviceId: 'device-a', meetingId: 'meeting-a', connectionId: 'old', generation: 1, socket: new FakeWebSocket(), ttlMs: 5 });
  now = 6;
  assert.equal(await registry.findDevice('meeting-a'), null);
  await two.connectDevice({ deviceId: 'device-a', meetingId: 'meeting-a', connectionId: 'new', generation: 2, socket: new FakeWebSocket(), ttlMs: 5 });
  assert.deepEqual(await registry.findDevice('meeting-a'), { role: 'device', deviceId: 'device-a', meetingId: 'meeting-a', connectionId: 'new', functionInstanceId: 'device-new', generation: 2, lastSequence: 0, expiresAt: 11 });
});

test('bounded request retry returns timeout instead of retaining a request forever', async () => {
  const ctx = setup({ requestTimeoutMs: 5, maxRequestRetries: 1 }); await ctx.state.setStatus('meeting-a', 'active');
  const device = new FakeWebSocket();
  await ctx.deviceInstance.connectDevice({ deviceId: 'device-a', meetingId: 'meeting-a', connectionId: 'device-1', socket: device });
  const viewer = new FakeWebSocket(); await ctx.viewerInstance.connectViewer({ meetingId: 'meeting-a', connectionId: 'viewer-1', socket: viewer });
  await wait(22);
  assert.equal(device.sent.filter((packet) => packet.type === 'snapshot.request').length, 2);
  assert.ok(viewer.sent.some((packet) => packet.code === 'relay_request_timeout'));
});
