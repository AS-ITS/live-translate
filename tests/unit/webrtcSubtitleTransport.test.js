import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebRtcSignalingClient } from '../../src/webrtc/signalingClient.js';
import { candidatePairEvidence, createWebRtcSubtitleTransport } from '../../src/webrtc/subtitleTransport.js';
import { configureLivePipelineTrace, livePipelineTrace } from '../../src/lib/livePipelineTrace.js';

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

test('Viewer requests a fresh negotiation when joining after an offer has expired', async () => {
  FakePeerConnection.instances = [];
  const requests = [];
  const transport = createWebRtcSubtitleTransport({
    meetingId: 'meeting-1', role: 'viewer', participantId: 'late-viewer', credential: { shareToken: 'token' },
    fetchImpl: async (url, init = {}) => {
      requests.push({ url, body: init.body ? JSON.parse(init.body) : null });
      if (url.endsWith('/join')) return response(200, { ttlMs: 60_000, iceServers: [] });
      if (url.endsWith('/signal')) return response(200, { accepted: true, sequence: 1 });
      if (url.endsWith('/leave')) return response(200, { left: true });
      return response(200, { messages: [], after: 0 });
    },
    RTCPeerConnectionImpl: FakePeerConnection,
    setTimer: () => ({ }), clearTimer: () => {},
  });
  transport.start();
  await flush(); await flush();
  assert.equal(requests.some(({ body }) => body?.type === 'viewer-ready' && body?.negotiationId), true);
  await transport.stop();
});

test('Device creates targeted peers for Viewers joining at different times', async () => {
  FakePeerConnection.instances = [];
  const requests = [];
  const timers = [];
  const ready = [
    { sequence: 1, participantId: 'viewer-a', type: 'viewer-ready', negotiationId: 'n-a', payload: {} },
    { sequence: 2, participantId: 'viewer-b', type: 'viewer-ready', negotiationId: 'n-b', payload: {} },
  ];
  let pollCount = 0;
  const transport = createWebRtcSubtitleTransport({
    meetingId: 'meeting-1', role: 'device', participantId: 'device-multi',
    fetchImpl: async (url, init = {}) => {
      requests.push({ url, body: init.body ? JSON.parse(init.body) : null });
      if (url.endsWith('/join')) return response(200, { ttlMs: 60_000, iceServers: [] });
      if (url.includes('/signal?')) {
        const message = ready[pollCount++];
        return response(200, { messages: message ? [message] : [], after: message?.sequence || 2 });
      }
      if (url.endsWith('/signal')) return response(200, { accepted: true, sequence: 3 });
      if (url.endsWith('/leave')) return response(200, { left: true });
      return response(200, {});
    },
    RTCPeerConnectionImpl: FakePeerConnection,
    setTimer(fn, ms) { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimer(timer) { timer.cleared = true; },
  });
  transport.start(); await flush(); await flush();
  for (let index = 0; index < 2; index += 1) {
    const poll = timers.find((timer) => timer.ms <= 2_000 && !timer.cleared);
    assert.ok(poll, 'Device keeps polling for late Viewer joins');
    timerClear(poll);
    await poll.fn(); await flush(); await flush();
  }
  const offers = requests.filter(({ body }) => body?.type === 'offer').map(({ body }) => body.targetParticipantId);
  assert.deepEqual(offers, ['viewer-a', 'viewer-b']);
  assert.equal(FakePeerConnection.instances.length, 2);
  await transport.stop();
  function timerClear(timer) { timer.cleared = true; }
});

test('Viewer rebuilds its channel after a transient failure and drops late old packets', async () => {
  FakePeerConnection.instances = [];
  const timers = [];
  const received = [];
  const statuses = [];
  const transport = createWebRtcSubtitleTransport({
    meetingId: 'meeting-1', role: 'viewer', participantId: 'viewer-recover', credential: { shareToken: 'token' },
    fetchImpl: async (url) => {
      if (url.endsWith('/join')) return response(200, { ttlMs: 60_000, iceServers: [] });
      if (url.endsWith('/signal')) return response(200, { accepted: true, sequence: 1 });
      if (url.endsWith('/leave')) return response(200, { left: true });
      return response(200, { messages: [], after: 0 });
    },
    RTCPeerConnectionImpl: FakePeerConnection,
    setTimer(fn, ms) { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimer(timer) { timer.cleared = true; },
    random: () => 0.5,
    onEnvelope: (packet) => received.push(packet),
    onStatus: (status) => statuses.push(status.value),
  });
  transport.start(); await flush(); await flush();
  const oldPeer = FakePeerConnection.instances[0];
  const oldChannel = new FakeDataChannel();
  oldPeer.ondatachannel({ channel: oldChannel });
  oldChannel.open();
  oldChannel.receive({ protocol: 'subtitle-webrtc/v1', type: 'snapshot', meetingId: 'meeting-1',
    sourceId: 'source-1', sequence: 1, cues: [{ cueId: 'cue-1', sourceText: 'one' }] });
  oldChannel.error();
  const retry = timers.find((timer) => timer.ms === 1_000 && !timer.cleared);
  assert.ok(retry);
  await retry.fn(); await flush(); await flush();
  const newPeer = FakePeerConnection.instances[1];
  const newChannel = new FakeDataChannel();
  newPeer.ondatachannel({ channel: newChannel });
  newChannel.open();
  newChannel.receive({ protocol: 'subtitle-webrtc/v1', type: 'snapshot', meetingId: 'meeting-1',
    sourceId: 'source-2', sequence: 2, cues: [{ cueId: 'cue-2', sourceText: 'two' }] });
  newChannel.receive({ protocol: 'subtitle-webrtc/v1', type: 'cue.append', meetingId: 'meeting-1',
    sourceId: 'source-2', sequence: 3, cue: { cueId: 'cue-3', sourceText: 'three' } });
  oldChannel.onclose?.();
  oldChannel.receive({ protocol: 'subtitle-webrtc/v1', type: 'cue.append', meetingId: 'meeting-1',
    sourceId: 'source-1', sequence: 3, cue: { cueId: 'late-old', sourceText: 'late' } });
  assert.deepEqual(received.flatMap((packet) => packet.cues?.map((cue) => cue.cueId) || [packet.cue?.cueId]), ['cue-1', 'cue-2', 'cue-3']);
  assert.equal(newChannel.closed, false, 'old generation close cannot tear down the open replacement channel');
  assert.equal(statuses.includes('reconnecting'), true);
  assert.equal(statuses.at(-1), 'restored');
  await transport.stop();
});

test('Device transport starts independently, publishes snapshot/update, and clears timers on stop', async () => {
  FakePeerConnection.instances = [];
  const requests = [];
  const timers = [];
  const statuses = [];
  const publicationErrors = [];
  let deliveredReady = false;
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    if (url.endsWith('/join')) return response(200, { iceServers: [], relayPolicy: 'direct-first' });
    if (url.includes('/signal?')) {
      if (!deliveredReady) {
        deliveredReady = true;
        return response(200, { messages: [{ sequence: 1, participantId: 'viewer-1', type: 'viewer-ready', negotiationId: 'n-1', payload: {} }], after: 1 });
      }
      return response(200, { messages: [], after: 1 });
    }
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
    onError: (error) => publicationErrors.push(error),
  });

  assert.doesNotThrow(() => transport.start());
  await flush();
  await flush();
  const join = requests.find((item) => item.url.endsWith('/join'));
  assert.deepEqual(join.body, { participantId: 'device-1', role: 'device' });
  const discoveryPoll = timers.find((timer) => timer.ms === 2_000 && !timer.cleared);
  discoveryPoll.cleared = true;
  await discoveryPoll.fn();
  await flush(); await flush();
  const peer = FakePeerConnection.instances[0];
  peer.channel.open();
  assert.equal(peer.channel.sent[0].type, 'snapshot');
  transport.publishCue({ cueId: 'cue-1', sequence: 1, sourceText: '修正版' });
  assert.equal(peer.channel.sent.at(-1).type, 'cue.update');

  configureLivePipelineTrace(true);
  livePipelineTrace.clear();
  assert.doesNotThrow(() => {
    transport.publishCue({ cueId: 'normal-1', rawSource: '正常原文 1', translatedText: 'normal 1' });
    transport.publishCue({ cueId: 'source-first', rawSource: '先到原文', sourceVersion: 8, sourceStatus: 'partial' });
    transport.publishCue({ cueId: 'source-first', rawSource: '先到原文', sourceVersion: 8, sourceStatus: 'finalized', translatedText: 'late translation', translationVersion: 1, translationStatus: 'finalized' });
    transport.publishCue({ cueId: 'translation-first', translatedText: 'translation first', translationVersion: 4, translationStatus: 'pending' });
    transport.publishCue({ cueId: 'translation-first', rawSource: '後到原文', sourceVersion: 1, sourceStatus: 'finalized', translatedText: 'translation first', translationVersion: 4, translationStatus: 'finalized' });
    transport.publishCue({ cueId: 'late-without-turn-id', rawSource: '無 turn id 後到原文', sourceVersion: 1 });
    transport.publishCue({ cueId: 'normal-2', rawSource: '正常原文 2', translatedText: 'normal 2' });
  });
  const published = peer.channel.sent.filter((packet) => packet.type === 'cue.append' || packet.type === 'cue.update');
  assert.deepEqual(published.slice(-7).map((packet) => packet.type), [
    'cue.append', 'cue.append', 'cue.update', 'cue.append', 'cue.update', 'cue.append', 'cue.append'
  ]);
  assert.equal(published.find((packet) => packet.cue.cueId === 'source-first' && packet.type === 'cue.append').cue.sourceText, '先到原文');

  assert.doesNotThrow(() => transport.publishCue({ cueId: 'malformed', rawSource: '', translatedText: '', sourceVersion: 1 }));
  assert.equal(publicationErrors.at(-1)?.code, 'empty_cue_content');
  const rejection = livePipelineTrace.get({ stage: 'DATA_CHANNEL_ENVELOPE_REJECTED' }).at(-1);
  assert.deepEqual({
    meetingId: rejection.meetingId,
    cueId: rejection.cueId,
    messageType: rejection.messageType,
    sourcePresent: rejection.sourcePresent,
    translationPresent: rejection.translationPresent,
    rawSourcePresent: rejection.rawSourcePresent,
    refinedSourcePresent: rejection.refinedSourcePresent,
    sourceVersion: rejection.sourceVersion,
    audioTurnIdPresent: rejection.audioTurnIdPresent,
    validatorCode: rejection.validatorCode
  }, {
    meetingId: 'meeting-1', cueId: 'malformed', messageType: 'cue.append',
    sourcePresent: false, translationPresent: false, rawSourcePresent: false,
    refinedSourcePresent: false, sourceVersion: 1, audioTurnIdPresent: false,
    validatorCode: 'empty_cue_content'
  });
  configureLivePipelineTrace(false);
  assert.equal(statuses.includes('connected'), true);

  await transport.stop();
  assert.equal(peer.closed, true);
  assert.equal(peer.channel.closed, true);
  assert.equal(timers.every((timer) => timer.cleared), true);
  assert.equal(requests.some((item) => item.url.endsWith('/leave')), true);
});

test('transport renews the participant heartbeat and uses low-frequency Device polling', async () => {
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
  const heartbeat = timers.find((timer) => timer.ms === 6_000 && !timer.cleared);
  assert.ok(heartbeat);
  assert.equal(timers.some((timer) => timer.ms === 250 && !timer.cleared), false);
  assert.ok(timers.find((timer) => timer.ms === 2_000 && !timer.cleared));
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
  assert.ok(timers.find((timer) => timer !== firstPoll && timer.ms === 1_000 && !timer.cleared));
  await transport.stop();
});

test('disconnected waits for grace period and Device attempts ICE restart before rebuilding', async () => {
  FakePeerConnection.instances = [];
  const timers = [];
  const requests = [];
  let deliveredReady = false;
  const transport = createWebRtcSubtitleTransport({
    meetingId: 'meeting-1', role: 'device', participantId: 'device-disconnected',
    fetchImpl: async (url, init = {}) => {
      requests.push({ url, body: init.body ? JSON.parse(init.body) : null });
      if (url.endsWith('/join')) return response(200, { ttlMs: 60_000, iceServers: [] });
      if (url.includes('/signal?')) {
        if (!deliveredReady) {
          deliveredReady = true;
          return response(200, { messages: [{ sequence: 1, participantId: 'viewer-1', type: 'viewer-ready', negotiationId: 'n-1', payload: {} }], after: 1 });
        }
        return response(200, { messages: [], after: 1 });
      }
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
  await timers.find((timer) => timer.ms === 2_000 && !timer.cleared).fn();
  await flush(); await flush();
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

test('Device DataChannel error closes only its peer while discovery keeps running', async () => {
  FakePeerConnection.instances = [];
  const timers = [];
  const statuses = [];
  let deliveredReady = false;
  const transport = createWebRtcSubtitleTransport({
    meetingId: 'meeting-1', role: 'device', participantId: 'device-channel-error',
    fetchImpl: async (url) => {
      if (url.endsWith('/join')) return response(200, { ttlMs: 60_000, iceServers: [] });
      if (url.includes('/signal?')) {
        if (!deliveredReady) {
          deliveredReady = true;
          return response(200, { messages: [{ sequence: 1, participantId: 'viewer-1', type: 'viewer-ready', negotiationId: 'n-1', payload: {} }], after: 1 });
        }
        return response(200, { messages: [], after: 1 });
      }
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
  await timers.find((timer) => timer.ms === 2_000 && !timer.cleared).fn();
  await flush(); await flush();
  FakePeerConnection.instances[0].channel.error();
  assert.equal(statuses.at(-1), 'reconnecting');
  assert.equal(FakePeerConnection.instances[0].closed, true);
  assert.ok(timers.find((timer) => timer.ms === 2_000 && !timer.cleared));
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

test('join 503 recovers, and a failed leave does not prevent the same participant from joining again', async () => {
  FakePeerConnection.instances = [];
  const timers = [];
  const requests = [];
  let joins = 0;
  const transport = createWebRtcSubtitleTransport({
    meetingId: 'meeting-1', role: 'device', participantId: 'device-stable',
    fetchImpl: async (url, init = {}) => {
      requests.push({ url, body: init.body && JSON.parse(init.body) });
      if (url.endsWith('/join')) return response(++joins === 1 ? 503 : 200, joins === 1
        ? { error: { code: 'webrtc_signaling_unavailable' } }
        : { ttlMs: 60_000, iceServers: [] });
      if (url.endsWith('/leave')) return response(503, { error: { code: 'webrtc_signaling_unavailable' } });
      if (url.includes('/signal?')) return response(200, { messages: [], after: 0 });
      return response(200, { accepted: true, sequence: 1 });
    },
    RTCPeerConnectionImpl: FakePeerConnection,
    random: () => 0.5,
    setTimer(fn, ms) { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimer(timer) { timer.cleared = true; }
  });
  transport.start();
  await flush();
  const retry = timers.find((timer) => timer.ms === 1_000 && !timer.cleared);
  assert.ok(retry);
  retry.fn();
  await flush();
  assert.equal(joins, 2);
  await transport.stop();
  transport.start();
  await flush();
  assert.equal(joins, 3);
  assert.deepEqual(requests.filter((item) => item.url.endsWith('/join')).map((item) => item.body.participantId),
    ['device-stable', 'device-stable', 'device-stable']);
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
