import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebRtcSignalingClient } from '../../src/webrtc/signalingClient.js';
import { candidatePairEvidence, createWebRtcSubtitleTransport } from '../../src/webrtc/subtitleTransport.js';

class FakeDataChannel {
  constructor() {
    this.readyState = 'connecting';
    this.sent = [];
    this.listeners = new Map();
    this.closed = false;
  }
  addEventListener(type, handler) { this.listeners.set(type, handler); }
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { this.closed = true; this.readyState = 'closed'; }
  open() { this.readyState = 'open'; this.onopen?.(); this.listeners.get('open')?.(); }
  receive(value) { this.listeners.get('message')?.({ data: JSON.stringify(value) }); }
  error(value = new Error('channel failed')) { this.onerror?.(value); this.listeners.get('error')?.(value); }
}

class FakePeerConnection {
  static instances = [];
  constructor(configuration) {
    this.configuration = configuration;
    this.connectionState = 'new';
    this.remoteDescription = null;
    this.channel = null;
    FakePeerConnection.instances.push(this);
  }
  createDataChannel() { this.channel = new FakeDataChannel(); return this.channel; }
  async createOffer() { return { type: 'offer', sdp: 'offer' }; }
  async createAnswer() { return { type: 'answer', sdp: 'answer' }; }
  async setLocalDescription(value) { this.localDescription = value; }
  async setRemoteDescription(value) { this.remoteDescription = value; }
  async addIceCandidate() {}
  restartIce() { this.restartedIce = true; }
  close() { this.closed = true; }
}

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

test('Device transport starts independently, publishes snapshot/update, and clears timers on stop', async () => {
  FakePeerConnection.instances = [];
  const requests = [];
  const timers = [];
  const statuses = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    if (url.endsWith('/join')) return response(200, { iceServers: [], relayPolicy: 'direct-first' });
    if (url.includes('/signal?')) return response(200, { messages: [], after: 0 });
    if (url.endsWith('/signal')) return response(200, { accepted: true, sequence: 1 });
    if (url.endsWith('/leave')) return response(200, { left: true });
    return response(404, { error: { code: 'not_found' } });
  };
  const transport = createWebRtcSubtitleTransport({
    meetingId: 'meeting-1',
    role: 'device',
    participantId: 'device-1',
    fetchImpl,
    RTCPeerConnectionImpl: FakePeerConnection,
    setTimer(fn, ms) { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimer(timer) { timer.cleared = true; },
    initialCues: [{ cueId: 'cue-1', sequence: 1, sourceText: '初稿' }],
    onStatus: (status) => statuses.push(status.value),
  });

  assert.doesNotThrow(() => transport.start());
  await flush();
  await flush();
  const join = requests.find((item) => item.url.endsWith('/join'));
  assert.deepEqual(join.body, { participantId: 'device-1', role: 'device' });
  const peer = FakePeerConnection.instances[0];
  peer.channel.open();
  assert.equal(peer.channel.sent[0].type, 'snapshot');
  transport.publishCue({ cueId: 'cue-1', sequence: 1, sourceText: '修正版' });
  assert.equal(peer.channel.sent.at(-1).type, 'cue.update');
  assert.equal(statuses.includes('connected'), true);

  await transport.stop();
  assert.equal(peer.closed, true);
  assert.equal(peer.channel.closed, true);
  assert.equal(timers.every((timer) => timer.cleared), true);
  assert.equal(requests.some((item) => item.url.endsWith('/leave')), true);
});

test('transport renews the participant heartbeat and stops high-frequency polling after DataChannel opens', async () => {
  FakePeerConnection.instances = [];
  const requests = [];
  const timers = [];
  const transport = createWebRtcSubtitleTransport({
    meetingId: 'meeting-1', role: 'device', participantId: 'device-heartbeat',
    fetchImpl: async (url) => {
      requests.push(url);
      if (url.endsWith('/join')) return response(200, { ttlMs: 12_000, iceServers: [] });
      if (url.includes('/signal?')) return response(200, { messages: [], after: 0 });
      if (url.endsWith('/signal')) return response(200, { accepted: true, sequence: 1 });
      if (url.endsWith('/leave')) return response(200, { left: true });
      return response(404, { error: { code: 'not_found' } });
    },
    RTCPeerConnectionImpl: FakePeerConnection,
    random: () => 0.5,
    setTimer(fn, ms) { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimer(timer) { timer.cleared = true; },
  });
  transport.start();
  await flush(); await flush();
  const peer = FakePeerConnection.instances[0];
  peer.channel.open();
  const heartbeat = timers.find((timer) => timer.ms === 6_000 && !timer.cleared);
  assert.ok(heartbeat);
  assert.equal(timers.some((timer) => timer.ms === 250 && !timer.cleared), false);
  await heartbeat.fn();
  await flush();
  assert.equal(requests.filter((url) => url.endsWith('/join')).length, 2);
  await transport.stop();
});

test('temporary polling failure keeps the current negotiation alive and retries polling', async () => {
  FakePeerConnection.instances = [];
  const timers = [];
  let polls = 0;
  const statuses = [];
  const transport = createWebRtcSubtitleTransport({
    meetingId: 'meeting-1', role: 'viewer', participantId: 'viewer-poll', credential: { shareToken: 'token' },
    fetchImpl: async (url) => {
      if (url.endsWith('/join')) return response(200, { ttlMs: 60_000, iceServers: [] });
      if (url.includes('/signal?')) return ++polls === 1
        ? response(503, { error: { code: 'webrtc_signaling_unavailable' } })
        : response(200, { messages: [], after: 0 });
      if (url.endsWith('/leave')) return response(200, { left: true });
      return response(200, {});
    },
    RTCPeerConnectionImpl: FakePeerConnection,
    random: () => 0.5,
    setTimer(fn, ms) { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimer(timer) { timer.cleared = true; },
    onStatus: (status) => statuses.push(status.value),
  });
  transport.start();
  await flush();
  const firstPoll = timers.find((timer) => timer.ms === 250 && !timer.cleared);
  await firstPoll.fn();
  await flush();
  assert.equal(FakePeerConnection.instances.length, 1);
  assert.equal(statuses.includes('reconnecting'), false);
  assert.ok(timers.find((timer) => timer !== firstPoll && timer.ms === 250 && !timer.cleared));
  await transport.stop();
});

test('disconnected waits for grace period and Device attempts ICE restart before rebuilding', async () => {
  FakePeerConnection.instances = [];
  const timers = [];
  const requests = [];
  const transport = createWebRtcSubtitleTransport({
    meetingId: 'meeting-1', role: 'device', participantId: 'device-disconnected',
    fetchImpl: async (url, init = {}) => {
      requests.push({ url, body: init.body ? JSON.parse(init.body) : null });
      if (url.endsWith('/join')) return response(200, { ttlMs: 60_000, iceServers: [] });
      if (url.includes('/signal?')) return response(200, { messages: [], after: 0 });
      if (url.endsWith('/signal')) return response(200, { accepted: true, sequence: 1 });
      if (url.endsWith('/leave')) return response(200, { left: true });
      return response(200, {});
    },
    RTCPeerConnectionImpl: FakePeerConnection,
    random: () => 0.5,
    setTimer(fn, ms) { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimer(timer) { timer.cleared = true; },
  });
  transport.start(); await flush(); await flush();
  const peer = FakePeerConnection.instances[0];
  peer.connectionState = 'disconnected';
  peer.onconnectionstatechange();
  assert.equal(peer.closed, undefined);
  const grace = timers.find((timer) => timer.ms === 5_000 && !timer.cleared);
  assert.ok(grace);
  await grace.fn(); await flush();
  assert.equal(peer.restartedIce, true);
  assert.equal(requests.some(({ body }) => body?.type === 'offer' && body.payload?.sdp === 'offer'), true);
  assert.ok(timers.find((timer) => timer.ms === 10_000 && !timer.cleared));
  await transport.stop();
});

test('DataChannel error triggers full transport recovery', async () => {
  FakePeerConnection.instances = [];
  const timers = [];
  const statuses = [];
  const transport = createWebRtcSubtitleTransport({
    meetingId: 'meeting-1', role: 'device', participantId: 'device-channel-error',
    fetchImpl: async (url) => {
      if (url.endsWith('/join')) return response(200, { ttlMs: 60_000, iceServers: [] });
      if (url.includes('/signal?')) return response(200, { messages: [], after: 0 });
      if (url.endsWith('/signal')) return response(200, { accepted: true, sequence: 1 });
      if (url.endsWith('/leave')) return response(200, { left: true });
      return response(200, {});
    },
    RTCPeerConnectionImpl: FakePeerConnection,
    random: () => 0.5,
    setTimer(fn, ms) { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimer(timer) { timer.cleared = true; },
    onStatus: (status) => statuses.push(status.value),
  });
  transport.start(); await flush(); await flush();
  FakePeerConnection.instances[0].channel.error();
  assert.equal(statuses.at(-1), 'reconnecting');
  assert.ok(timers.find((timer) => timer.ms === 1_000 && !timer.cleared));
  await transport.stop();
});

test('late join from an old connection epoch cannot replace the current peer', async () => {
  FakePeerConnection.instances = [];
  const firstJoin = deferred();
  let joins = 0;
  const transport = createWebRtcSubtitleTransport({
    meetingId: 'meeting-1', role: 'viewer', participantId: 'viewer-epoch', credential: { shareToken: 'token' },
    fetchImpl: async (url) => {
      if (url.endsWith('/join')) {
        joins += 1;
        if (joins === 1) return firstJoin.promise;
        return response(200, { ttlMs: 60_000, iceServers: [] });
      }
      if (url.includes('/signal?')) return response(200, { messages: [], after: 0 });
      if (url.endsWith('/leave')) return response(200, { left: true });
      return response(200, {});
    },
    RTCPeerConnectionImpl: FakePeerConnection,
  });
  transport.start();
  await flush();
  transport.retry();
  await flush(); await flush();
  firstJoin.resolve(response(200, { ttlMs: 60_000, iceServers: [{ urls: ['stun:stale.example'] }] }));
  await flush();
  assert.equal(FakePeerConnection.instances.length, 1);
  assert.deepEqual(FakePeerConnection.instances[0].configuration, { iceServers: [] });
  await transport.stop();
});

test('transport stops after six bounded reconnect attempts', async () => {
  const timers = [];
  const statuses = [];
  let joins = 0;
  const transport = createWebRtcSubtitleTransport({
    meetingId: 'meeting-1', role: 'device', participantId: 'device-exhausted',
    fetchImpl: async () => { joins += 1; return response(503, { error: { code: 'webrtc_signaling_unavailable' } }); },
    RTCPeerConnectionImpl: FakePeerConnection,
    random: () => 0.5,
    setTimer(fn, ms) { const timer = { fn, ms, executed: false }; timers.push(timer); return timer; },
    clearTimer() {},
    onStatus: (status) => statuses.push(status),
  });
  transport.start();
  await flush();
  for (let index = 0; index < 6; index += 1) {
    const timer = timers.find((item) => !item.executed);
    assert.ok(timer);
    timer.executed = true;
    timer.fn();
    await flush();
  }
  assert.equal(joins, 7);
  assert.equal(statuses.at(-1).value, 'failed');
  assert.equal(statuses.at(-1).attempts, 6);
  await transport.stop();
});

test('signaling requests abort after the eight-second timeout', async () => {
  const timers = [];
  const client = createWebRtcSignalingClient({
    meetingId: 'meeting-1', participantId: 'viewer-timeout', role: 'viewer', credential: { shareToken: 'token' },
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }),
    setTimer(fn, ms) { const timer = { fn, ms }; timers.push(timer); return timer; },
    clearTimer() {},
  });
  const pending = client.join();
  assert.equal(timers[0].ms, 8_000);
  timers[0].fn();
  await assert.rejects(() => pending, (error) => error.code === 'webrtc_signaling_timeout' && error.status === 504);
});

test('offline recovery pauses retry counting and resumes immediately on online', async () => {
  FakePeerConnection.instances = [];
  const listeners = new Map();
  const lifecycleTarget = {
    addEventListener(type, handler) { listeners.set(type, handler); },
    removeEventListener(type) { listeners.delete(type); },
  };
  let online = false;
  let joins = 0;
  const statuses = [];
  const transport = createWebRtcSubtitleTransport({
    meetingId: 'meeting-1', role: 'viewer', participantId: 'viewer-online', credential: { shareToken: 'token' },
    fetchImpl: async (url) => {
      if (url.endsWith('/join')) {
        joins += 1;
        return joins === 1
          ? response(503, { error: { code: 'webrtc_signaling_unavailable' } })
          : response(200, { ttlMs: 60_000, iceServers: [] });
      }
      if (url.includes('/signal?')) return response(200, { messages: [], after: 0 });
      if (url.endsWith('/leave')) return response(200, { left: true });
      return response(200, {});
    },
    RTCPeerConnectionImpl: FakePeerConnection,
    lifecycleTarget,
    documentRef: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
    isOnline: () => online,
    onStatus: (status) => statuses.push(status),
  });
  transport.start();
  await flush();
  assert.equal(statuses.at(-1).reason, 'network_offline');
  assert.equal(statuses.at(-1).attempt, 0);
  online = true;
  listeners.get('online')();
  await flush(); await flush();
  assert.equal(joins, 2);
  assert.equal(FakePeerConnection.instances.length, 1);
  await transport.stop();
});

test('failed Device signaling schedules reconnect without rejecting recording startup', async () => {
  const statuses = [];
  const timers = [];
  const transport = createWebRtcSubtitleTransport({
    meetingId: 'meeting-1',
    role: 'device',
    participantId: 'device-1',
    fetchImpl: async () => response(503, { error: { code: 'webrtc_signaling_unavailable' } }),
    RTCPeerConnectionImpl: FakePeerConnection,
    random: () => 0.5,
    setTimer(fn, ms) { const timer = { fn, ms }; timers.push(timer); return timer; },
    clearTimer() {},
    onStatus: (status) => statuses.push(status.value),
  });
  assert.equal(transport.start(), undefined);
  await flush();
  assert.deepEqual(statuses.slice(0, 2), ['connecting', 'reconnecting']);
  assert.equal(timers[0].ms, 1_000);
  await transport.stop();
});

test('Viewer signaling sends only the selected share credential and exposes safe error codes', async () => {
  const requests = [];
  const client = createWebRtcSignalingClient({
    meetingId: 'meeting-1',
    participantId: 'viewer-1',
    role: 'viewer',
    credential: { shareCode: 'SDR96VY9' },
    fetchImpl: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) });
      return response(200, { participant: { role: 'viewer' } });
    },
  });
  await client.join();
  assert.deepEqual(requests[0].body, { participantId: 'viewer-1', role: 'viewer', shareCode: 'SDR96VY9' });

  const denied = createWebRtcSignalingClient({
    meetingId: 'meeting-1',
    participantId: 'viewer-2',
    role: 'viewer',
    credential: { shareToken: 'secret-token-never-log' },
    fetchImpl: async () => response(403, { error: { code: 'share_unauthorized' } }),
  });
  await assert.rejects(() => denied.join(), (error) => (
    error.code === 'share_unauthorized'
    && error.message === '分享已失效。'
    && !error.message.includes('secret-token-never-log')
  ));
});

test('candidate evidence exposes selected pair metadata without signaling credentials', () => {
  const stats = new Map([
    ['local-1', { id: 'local-1', type: 'local-candidate', candidateType: 'srflx' }],
    ['remote-1', { id: 'remote-1', type: 'remote-candidate', candidateType: 'host' }],
    ['pair-1', { id: 'pair-1', type: 'candidate-pair', state: 'succeeded', nominated: true, localCandidateId: 'local-1', remoteCandidateId: 'remote-1', currentRoundTripTime: 0.04, timestamp: 123 }],
  ]);
  assert.deepEqual(candidatePairEvidence(stats), [{
    pairId: 'pair-1', state: 'succeeded', selected: false, nominated: true,
    localCandidateType: 'srflx', remoteCandidateType: 'host', currentRoundTripTime: 0.04, timestamp: 123,
  }]);
});
