import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebRtcSignalingClient } from '../../src/webrtc/signalingClient.js';
import { candidatePairEvidence, createWebRtcSubtitleTransport, MAX_RECOVERY_ATTEMPTS } from '../../src/webrtc/subtitleTransport.js';
import { configureLivePipelineTrace, livePipelineTrace } from '../../src/lib/livePipelineTrace.js';

class FakeDataChannel {
  constructor(peer = null) {
    this.peer = peer;
    this.readyState = 'connecting';
    this.sent = [];
    this.listeners = new Map();
    this.closed = false;
  }
  addEventListener(type, handler) { this.listeners.set(type, handler); }
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { this.closed = true; this.readyState = 'closed'; }
  open({ markPeerConnected = true } = {}) {
    this.readyState = 'open';
    if (this.peer && markPeerConnected) {
      this.peer.connectionState = 'connected';
      this.peer.iceConnectionState = 'connected';
    }
    this.onopen?.();
    this.listeners.get('open')?.();
  }
  remoteClose() { this.readyState = 'closed'; this.onclose?.(); this.listeners.get('close')?.(); }
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
  createDataChannel() { this.channel = new FakeDataChannel(this); return this.channel; }
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

function createViewerTransport({ timers = [], statuses = [], onEnvelope } = {}) {
  return createWebRtcSubtitleTransport({
    meetingId: 'meeting-1', role: 'viewer', participantId: 'viewer-regression', credential: { shareToken: 'token' },
    fetchImpl: async (url) => {
      if (url.endsWith('/join')) return response(200, { ttlMs: 60_000, iceServers: [] });
      if (url.endsWith('/signal')) return response(200, { accepted: true, sequence: 1 });
      if (url.endsWith('/leave')) return response(200, { left: true });
      return response(200, { messages: [], after: 0 });
    },
    RTCPeerConnectionImpl: FakePeerConnection,
    random: () => 0.5,
    setTimer(fn, ms) { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimer(timer) { timer.cleared = true; },
    onStatus: (status) => statuses.push(status),
    onEnvelope,
  });
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

test('Recorder and Viewer traces correlate one negotiation without retaining signaling payloads', async () => {
  FakePeerConnection.instances = [];
  configureLivePipelineTrace(true);
  livePipelineTrace.clear();
  const viewerTimers = [];
  const recorderTimers = [];
  let viewerReady = null;
  const expiresAt = 1_760_000_030_000;
  const viewer = createWebRtcSubtitleTransport({
    meetingId: 'meeting-paired', role: 'viewer', participantId: 'viewer-paired',
    credential: { shareToken: 'secret-share-token' },
    fetchImpl: async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : null;
      if (url.endsWith('/join')) return response(200, { ttlMs: 60_000, iceServers: [] });
      if (url.endsWith('/signal')) {
        if (body?.type === 'viewer-ready') viewerReady = body;
        return response(200, { accepted: true, sequence: 10, expiresAt });
      }
      if (url.endsWith('/leave')) return response(200, { left: true });
      return response(200, { messages: [], after: 10 });
    },
    RTCPeerConnectionImpl: FakePeerConnection,
    setTimer(fn, ms) { const timer = { fn, ms, cleared: false }; viewerTimers.push(timer); return timer; },
    clearTimer(timer) { timer.cleared = true; },
  });
  const recorder = createWebRtcSubtitleTransport({
    meetingId: 'meeting-paired', role: 'device', participantId: 'recorder-paired',
    fetchImpl: async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : null;
      if (url.endsWith('/join')) return response(200, { ttlMs: 60_000, iceServers: [] });
      if (url.includes('/signal?')) return response(200, {
        messages: [{
          sequence: 10,
          expiresAt,
          participantId: 'viewer-paired',
          type: 'viewer-ready',
          negotiationId: viewerReady.negotiationId,
          payload: {},
        }],
        after: 10,
      });
      if (url.endsWith('/signal')) {
        assert.equal(body.type, 'offer');
        return response(200, { accepted: true, sequence: 11, expiresAt: expiresAt + 1 });
      }
      if (url.endsWith('/leave')) return response(200, { left: true });
      return response(200, {});
    },
    RTCPeerConnectionImpl: FakePeerConnection,
    setTimer(fn, ms) { const timer = { fn, ms, cleared: false }; recorderTimers.push(timer); return timer; },
    clearTimer(timer) { timer.cleared = true; },
  });

  viewer.start();
  recorder.start();
  await flush(); await flush();
  const recorderPoll = recorderTimers.find((timer) => timer.ms === 2_000 && !timer.cleared);
  recorderPoll.cleared = true;
  await recorderPoll.fn();
  await flush(); await flush();

  const traces = livePipelineTrace.get({ stage: 'WEBRTC_SIGNALING' });
  const sent = traces.find((entry) => entry.eventType === 'viewer-ready.sent');
  const received = traces.find((entry) => entry.eventType === 'viewer-ready.received');
  const poll = traces.find((entry) => entry.role === 'recorder' && entry.eventType === 'poll.success');
  assert.equal(sent.negotiationId, received.negotiationId);
  assert.equal(sent.signalSequence, 10);
  assert.equal(received.signalSequence, 10);
  assert.equal(received.viewerId, 'viewer-paired');
  assert.equal(poll.signalingCursorBefore, 0);
  assert.equal(poll.signalingCursorAfter, 10);
  assert.equal(poll.signalMessageCount, 1);
  assert.equal(traces.find((entry) => entry.role === 'viewer' && entry.eventType === 'join.success').participantTtlMs, 60_000);
  assert.doesNotMatch(JSON.stringify(traces), /secret-share-token|offer-sdp|candidate:/u);

  await viewer.stop();
  await recorder.stop();
  configureLivePipelineTrace(false);
});

test('signaling rejection records the first failed operation without credentials or SDP', async () => {
  FakePeerConnection.instances = [];
  configureLivePipelineTrace(true);
  livePipelineTrace.clear();
  const transport = createWebRtcSubtitleTransport({
    meetingId: 'meeting-signal-failure', role: 'viewer', participantId: 'viewer-signal-failure',
    credential: { shareToken: 'secret-share-token' },
    fetchImpl: async (url) => {
      if (url.endsWith('/join')) return response(200, { ttlMs: 60_000, iceServers: [] });
      if (url.endsWith('/signal')) return response(503, {
        error: { code: 'webrtc_signaling_unavailable', detail: 'v=0 secret-sdp' },
      });
      if (url.endsWith('/leave')) return response(200, { left: true });
      return response(200, { messages: [], after: 0 });
    },
    RTCPeerConnectionImpl: FakePeerConnection,
    setTimer: () => ({}),
    clearTimer: () => {},
  });

  transport.start();
  await flush(); await flush();
  const failed = livePipelineTrace.get({ stage: 'WEBRTC_SIGNALING' })
    .find((entry) => entry.eventType === 'viewer-ready.failed');
  assert.equal(failed.errorCode, 'webrtc_signaling_unavailable');
  assert.equal(failed.httpStatus, 503);
  assert.equal(failed.transportResult, 'failed');
  assert.doesNotMatch(JSON.stringify(livePipelineTrace.get()), /secret-share-token|secret-sdp|v=0/u);

  await transport.stop();
  configureLivePipelineTrace(false);
});

test('Viewer keeps advertising one negotiation while waiting for a Recorder', async () => {
  FakePeerConnection.instances = [];
  const requests = [];
  const timers = [];
  const statuses = [];
  const transport = createWebRtcSubtitleTransport({
    meetingId: 'meeting-1', role: 'viewer', participantId: 'viewer-waiting', credential: { shareToken: 'token' },
    fetchImpl: async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : null;
      requests.push({ url, body });
      if (url.endsWith('/join')) return response(200, { ttlMs: 60_000, iceServers: [] });
      if (url.endsWith('/signal')) return response(200, { accepted: true, sequence: requests.length });
      if (url.endsWith('/leave')) return response(200, { left: true });
      return response(200, { messages: [], after: 0 });
    },
    RTCPeerConnectionImpl: FakePeerConnection,
    setTimer(fn, ms) { const timer = { fn, ms, cleared: false, executed: false }; timers.push(timer); return timer; },
    clearTimer(timer) { timer.cleared = true; },
    onStatus: (status) => statuses.push(status),
  });

  transport.start();
  await flush(); await flush();
  for (let cycle = 0; cycle < MAX_RECOVERY_ATTEMPTS + 2; cycle += 1) {
    const timer = timers.find((item) => item.ms === 12_000 && !item.cleared && !item.executed);
    assert.ok(timer, `missing Viewer discovery timer for cycle ${cycle + 1}`);
    timer.executed = true;
    timer.cleared = true;
    await timer.fn();
    await flush(); await flush();
  }

  const readyRequests = requests.filter(({ body }) => body?.type === 'viewer-ready');
  assert.equal(readyRequests.length, MAX_RECOVERY_ATTEMPTS + 3);
  assert.equal(new Set(readyRequests.map(({ body }) => body.negotiationId)).size, 1);
  assert.equal(FakePeerConnection.instances.length, 1);
  assert.equal(statuses.some(({ value }) => value === 'recovery_failed'), false);
  assert.equal(statuses.at(-1).value, 'waiting');
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

test('Device deduplicates repeated viewer-ready backlog for one in-flight negotiation', async () => {
  FakePeerConnection.instances = [];
  const requests = [];
  const timers = [];
  const repeatedReady = [1, 2, 3].map((sequence) => ({
    sequence,
    participantId: 'viewer-waiting',
    type: 'viewer-ready',
    negotiationId: 'negotiation-waiting',
    payload: {},
  }));
  const transport = createWebRtcSubtitleTransport({
    meetingId: 'meeting-1', role: 'device', participantId: 'device-starting',
    fetchImpl: async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : null;
      requests.push({ url, body });
      if (url.endsWith('/join')) return response(200, { ttlMs: 60_000, iceServers: [] });
      if (url.includes('/signal?')) return response(200, { messages: repeatedReady, after: 3 });
      if (url.endsWith('/signal')) return response(200, { accepted: true, sequence: 4 });
      if (url.endsWith('/leave')) return response(200, { left: true });
      return response(200, {});
    },
    RTCPeerConnectionImpl: FakePeerConnection,
    setTimer(fn, ms) { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimer(timer) { timer.cleared = true; },
  });

  transport.start(); await flush(); await flush();
  const poll = timers.find((timer) => timer.ms === 2_000 && !timer.cleared);
  assert.ok(poll, 'Recorder polls the signaling backlog after starting');
  poll.cleared = true;
  await poll.fn(); await flush(); await flush();

  const offers = requests.filter(({ body }) => body?.type === 'offer');
  assert.equal(offers.length, 1, 'one negotiation must create exactly one offer');
  assert.equal(FakePeerConnection.instances.length, 1, 'duplicate ready messages must not replace the in-flight peer');
  await transport.stop();
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
  const oldChannel = new FakeDataChannel(oldPeer);
  oldPeer.ondatachannel({ channel: oldChannel });
  oldChannel.open();
  oldChannel.receive({ protocol: 'subtitle-webrtc/v1', type: 'snapshot', meetingId: 'meeting-1',
    sourceId: 'source-1', sequence: 1, cues: [{ cueId: 'cue-1', sourceText: 'one' }] });
  oldChannel.error();
  const retry = timers.find((timer) => timer.ms === 1_000 && !timer.cleared);
  assert.ok(retry);
  await retry.fn(); await flush(); await flush();
  const newPeer = FakePeerConnection.instances[1];
  const newChannel = new FakeDataChannel(newPeer);
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

test('Viewer transient ICE disconnect recovers inside grace without reload or peer rebuild', async () => {
  FakePeerConnection.instances = [];
  const timers = [];
  const statuses = [];
  const transport = createViewerTransport({ timers, statuses });
  transport.start(); await flush(); await flush();
  const peer = FakePeerConnection.instances[0];
  const channel = new FakeDataChannel(peer);
  peer.ondatachannel({ channel });
  channel.open();

  peer.connectionState = 'disconnected';
  peer.iceConnectionState = 'disconnected';
  peer.onconnectionstatechange();
  const grace = timers.find((timer) => timer.ms === 5_000 && !timer.cleared);
  assert.ok(grace);
  assert.equal(statuses.at(-1).value, 'connected');
  assert.equal(statuses.some(({ value }) => value === 'reconnecting'), false);

  peer.connectionState = 'connected';
  peer.iceConnectionState = 'connected';
  peer.oniceconnectionstatechange();
  assert.equal(grace.cleared, true);
  assert.equal(FakePeerConnection.instances.length, 1);
  assert.equal(peer.closed, undefined);
  assert.equal(statuses.at(-1).value, 'connected');
  await transport.stop();
});

test('Viewer reports connected when DataChannel is open before PeerConnection settles', async () => {
  FakePeerConnection.instances = [];
  const statuses = [];
  const transport = createViewerTransport({ statuses });
  transport.start(); await flush(); await flush();
  const peer = FakePeerConnection.instances[0];
  peer.connectionState = 'connecting';
  peer.iceConnectionState = 'checking';
  const channel = new FakeDataChannel(peer);
  peer.ondatachannel({ channel });
  channel.open({ markPeerConnected: false });

  assert.equal(statuses.at(-1).value, 'connected');
  assert.equal(statuses.at(-1).connectionState, 'connecting');
  assert.equal(statuses.at(-1).iceConnectionState, 'checking');
  assert.equal(statuses.at(-1).dataChannelState, 'open');
  assert.equal(statuses.at(-1).transportGeneration, 1);
  assert.equal(statuses.at(-1).lastReceivedCueSequence, 0);
  await transport.stop();
});

test('healthy DataChannel suppresses ICE disconnected recovery after grace', async () => {
  FakePeerConnection.instances = [];
  const timers = [];
  const statuses = [];
  const transport = createViewerTransport({ timers, statuses });
  transport.start(); await flush(); await flush();
  const peer = FakePeerConnection.instances[0];
  const channel = new FakeDataChannel(peer);
  peer.ondatachannel({ channel });
  channel.open();
  peer.connectionState = 'disconnected';
  peer.iceConnectionState = 'disconnected';
  peer.onconnectionstatechange();

  const grace = timers.find((timer) => timer.ms === 5_000 && !timer.cleared);
  assert.ok(grace);
  await grace.fn();
  assert.equal(statuses.at(-1).value, 'connected');
  assert.equal(statuses.some(({ value }) => value === 'reconnecting'), false);
  assert.equal(FakePeerConnection.instances.length, 1);
  assert.equal(peer.closed, undefined);
  await transport.stop();
});

test('Viewer closed DataChannel rebuilds peer, opens replacement, and requests replay', async () => {
  FakePeerConnection.instances = [];
  const timers = [];
  const statuses = [];
  const transport = createViewerTransport({ timers, statuses });
  transport.start(); await flush(); await flush();
  const firstPeer = FakePeerConnection.instances[0];
  const firstChannel = new FakeDataChannel(firstPeer);
  firstPeer.ondatachannel({ channel: firstChannel });
  firstChannel.open();
  firstChannel.remoteClose();
  assert.equal(statuses.at(-1).value, 'reconnecting');

  const retry = timers.find((timer) => timer.ms === 1_000 && !timer.cleared);
  retry.cleared = true;
  await retry.fn(); await flush(); await flush();
  const replacementPeer = FakePeerConnection.instances[1];
  const replacementChannel = new FakeDataChannel(replacementPeer);
  replacementPeer.ondatachannel({ channel: replacementChannel });
  replacementChannel.open();
  assert.equal(firstPeer.closed, true);
  assert.equal(replacementChannel.sent.at(-1).type, 'replay.request');
  assert.equal(statuses.at(-1).value, 'restored');
  assert.equal(statuses.some((status) => status.value === 'recovery_failed'), false);
  await transport.stop();
});

test('open but silent DataChannel fails liveness and starts automatic recovery', async () => {
  FakePeerConnection.instances = [];
  const timers = [];
  const statuses = [];
  let currentTime = 0;
  const transport = createWebRtcSubtitleTransport({
    meetingId: 'meeting-1', role: 'viewer', participantId: 'viewer-liveness', credential: { shareToken: 'token' },
    fetchImpl: async (url) => {
      if (url.endsWith('/join')) return response(200, { ttlMs: 60_000, iceServers: [] });
      if (url.endsWith('/signal')) return response(200, { accepted: true, sequence: 1 });
      if (url.endsWith('/leave')) return response(200, { left: true });
      return response(200, { messages: [], after: 0 });
    },
    RTCPeerConnectionImpl: FakePeerConnection,
    now: () => currentTime,
    random: () => 0.5,
    setTimer(fn, ms) { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimer(timer) { timer.cleared = true; },
    onStatus: (status) => statuses.push(status),
  });
  transport.start(); await flush(); await flush();
  const peer = FakePeerConnection.instances[0];
  const channel = new FakeDataChannel(peer);
  peer.ondatachannel({ channel });
  channel.open();

  const firstCheck = timers.find((timer) => timer.ms === 10_000 && !timer.cleared);
  firstCheck.cleared = true;
  firstCheck.fn();
  assert.equal(channel.sent.at(-1).type, 'liveness.ping');
  currentTime = 30_000;
  const timeoutCheck = timers.find((timer) => timer.ms === 10_000 && !timer.cleared);
  timeoutCheck.cleared = true;
  timeoutCheck.fn();
  assert.equal(peer.closed, true);
  assert.equal(statuses.at(-1).value, 'reconnecting');
  assert.ok(timers.find((timer) => timer.ms === 0 && !timer.cleared));
  await transport.stop();
});

test('stale reconnect timer cannot close an already connected replacement generation', async () => {
  FakePeerConnection.instances = [];
  configureLivePipelineTrace(true);
  livePipelineTrace.clear();
  const timers = [];
  const transport = createViewerTransport({ timers });
  transport.start(); await flush(); await flush();
  const firstPeer = FakePeerConnection.instances[0];
  const firstChannel = new FakeDataChannel(firstPeer);
  firstPeer.ondatachannel({ channel: firstChannel });
  firstChannel.open();
  firstChannel.remoteClose();
  const staleTimer = timers.find((timer) => timer.ms === 1_000 && !timer.cleared);

  transport.retry(); await flush(); await flush();
  const replacementPeer = FakePeerConnection.instances[1];
  const replacementChannel = new FakeDataChannel(replacementPeer);
  replacementPeer.ondatachannel({ channel: replacementChannel });
  replacementChannel.open();
  await staleTimer.fn(); await flush();

  assert.equal(replacementPeer.closed, undefined);
  assert.equal(replacementChannel.closed, false);
  assert.equal(FakePeerConnection.instances.length, 2);
  assert.equal(livePipelineTrace.get({ stage: 'WEBRTC_TRANSPORT_RECOVERY' })
    .some((entry) => entry.eventType === 'STALE_GENERATION_IGNORED'), true);
  await transport.stop();
  configureLivePipelineTrace(false);
});

test('Viewer replay cursor acknowledges only validated delivery', async () => {
  FakePeerConnection.instances = [];
  const timers = [];
  let accept = false;
  const transport = createViewerTransport({ timers, onEnvelope: (packet) => (
    accept ? { sourceId: packet.sourceId, sequence: packet.sequence } : null
  ) });
  const snapshot = { protocol: 'subtitle-webrtc/v1', type: 'snapshot', meetingId: 'meeting-1',
    sourceId: 'source-1', sequence: 1, cues: [{ cueId: 'cue-1', sourceText: 'one' }] };
  const open = async () => {
    await flush(); await flush();
    const peer = FakePeerConnection.instances.at(-1);
    const channel = new FakeDataChannel(peer);
    peer.ondatachannel({ channel });
    channel.open();
    return channel;
  };
  const reconnect = async (channel) => {
    channel.remoteClose();
    const timer = timers.find((item) => item.ms === 1_000 && !item.cleared);
    assert.ok(timer);
    timer.cleared = true;
    await timer.fn();
    return open();
  };
  transport.start();
  try {
    let channel = await open();
    channel.receive(snapshot);
    channel = await reconnect(channel);
    assert.equal(channel.sent.at(-1).afterSequence, 0);
    accept = true;
    channel.receive(snapshot);
    channel = await reconnect(channel);
    assert.equal(channel.sent.at(-1).afterSequence, 1);
  } finally {
    await transport.stop();
  }
});

test('Viewer recovery replays missing cues before continuing live delivery', async () => {
  FakePeerConnection.instances = [];
  const timers = [];
  const received = [];
  const transport = createViewerTransport({ timers, onEnvelope: (packet) => {
    received.push(packet);
    return { sourceId: packet.sourceId, sequence: packet.toSequence ?? packet.sequence };
  } });
  transport.start(); await flush(); await flush();
  const firstPeer = FakePeerConnection.instances[0];
  const firstChannel = new FakeDataChannel(firstPeer);
  firstPeer.ondatachannel({ channel: firstChannel });
  firstChannel.open();
  firstChannel.receive({ protocol: 'subtitle-webrtc/v1', type: 'snapshot', meetingId: 'meeting-1',
    sourceId: 'source-1', sequence: 1, cues: [{ cueId: 'cue-1', sourceText: 'one' }] });
  firstChannel.remoteClose();
  const retry = timers.find((timer) => timer.ms === 1_000 && !timer.cleared);
  retry.cleared = true;
  await retry.fn(); await flush(); await flush();

  const replacementPeer = FakePeerConnection.instances[1];
  const replacementChannel = new FakeDataChannel(replacementPeer);
  replacementPeer.ondatachannel({ channel: replacementChannel });
  replacementChannel.open();
  assert.deepEqual(replacementChannel.sent.at(-1), {
    protocol: 'subtitle-webrtc/v1', type: 'replay.request', meetingId: 'meeting-1',
    requestId: replacementChannel.sent.at(-1).requestId, sourceId: 'source-1', afterSequence: 1,
  });
  replacementChannel.receive({ protocol: 'subtitle-webrtc/v1', type: 'replay.response', meetingId: 'meeting-1',
    sourceId: 'source-1', requestId: 'replay-response', fromSequence: 1, toSequence: 2,
    events: [{ protocol: 'subtitle-webrtc/v1', type: 'cue.append', meetingId: 'meeting-1', sourceId: 'source-1',
      sequence: 2, cue: { cueId: 'cue-2', sourceText: 'two' } }] });
  replacementChannel.receive({ protocol: 'subtitle-webrtc/v1', type: 'cue.append', meetingId: 'meeting-1',
    sourceId: 'source-1', sequence: 3, cue: { cueId: 'cue-3', sourceText: 'three' } });
  assert.deepEqual(received.flatMap((packet) => packet.cues?.map((cue) => cue.cueId)
    || packet.events?.map((event) => event.cue.cueId) || [packet.cue?.cueId]), ['cue-1', 'cue-2', 'cue-3']);
  await transport.stop();
});

test('Viewer survives ten disconnect and rebuild cycles without stale peers or timers', async () => {
  FakePeerConnection.instances = [];
  const timers = [];
  const transport = createViewerTransport({ timers });
  transport.start(); await flush(); await flush();
  for (let cycle = 0; cycle < 10; cycle += 1) {
    const peer = FakePeerConnection.instances.at(-1);
    const channel = new FakeDataChannel(peer);
    peer.ondatachannel({ channel });
    channel.open();
    channel.remoteClose();
    const retry = timers.find((timer) => timer.ms === 1_000 && !timer.cleared);
    assert.ok(retry, `cycle ${cycle + 1} schedules recovery`);
    retry.cleared = true;
    await retry.fn(); await flush(); await flush();
  }
  const finalPeer = FakePeerConnection.instances.at(-1);
  const finalChannel = new FakeDataChannel(finalPeer);
  finalPeer.ondatachannel({ channel: finalChannel });
  finalChannel.open();
  assert.equal(FakePeerConnection.instances.filter((peer) => !peer.closed).length, 1);
  assert.equal(timers.filter((timer) => !timer.cleared).length <= 4, true);
  await transport.stop();
  assert.equal(timers.every((timer) => timer.cleared), true);
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
    initialCues: [{ cueId: 'cue-1', sequence: 1, revision: 1, status: 'final', sourceText: '初稿' }],
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
  transport.publishCue({ cueId: 'cue-1', sequence: 1, revision: 2, status: 'final', sourceText: '修正版' });
  assert.equal(peer.channel.sent.at(-1).type, 'cue.update');
  assert.equal(peer.channel.sent.at(-1).cue.revision, 2);
  assert.equal(transport.publishCue({ cueId: 'uncommitted', status: 'final', sourceText: 'not durable' }), false);

  configureLivePipelineTrace(true);
  livePipelineTrace.clear();
  assert.doesNotThrow(() => {
    transport.publishCue({ cueId: 'normal-1', revision: 1, rawSource: '正常原文 1', translatedText: 'normal 1' });
    transport.publishCue({ cueId: 'source-first', revision: 1, rawSource: '先到原文', sourceVersion: 8, sourceStatus: 'partial' });
    transport.publishCue({ cueId: 'source-first', revision: 2, rawSource: '先到原文', sourceVersion: 8, sourceStatus: 'finalized', translatedText: 'late translation', translationVersion: 1, translationStatus: 'finalized' });
    transport.publishCue({ cueId: 'translation-first', revision: 1, translatedText: 'translation first', translationVersion: 4, translationStatus: 'pending' });
    transport.publishCue({ cueId: 'translation-first', revision: 2, rawSource: '後到原文', sourceVersion: 1, sourceStatus: 'finalized', translatedText: 'translation first', translationVersion: 4, translationStatus: 'finalized' });
    transport.publishCue({ cueId: 'late-without-turn-id', revision: 1, rawSource: '無 turn id 後到原文', sourceVersion: 1 });
    transport.publishCue({ cueId: 'normal-2', revision: 1, rawSource: '正常原文 2', translatedText: 'normal 2' });
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

test('open DataChannel cancels negotiation timeout before PeerConnection connected event and carries twenty Cues', async () => {
  FakePeerConnection.instances = [];
  const timers = [];
  let deliveredReady = false;
  const transport = createWebRtcSubtitleTransport({
    meetingId: 'meeting-1', role: 'device', participantId: 'device-resumed',
    fetchImpl: async (url) => {
      if (url.endsWith('/join')) return response(200, { ttlMs: 60_000, iceServers: [] });
      if (url.includes('/signal?')) {
        if (!deliveredReady) {
          deliveredReady = true;
          return response(200, {
            messages: [{ sequence: 1, participantId: 'viewer-1', type: 'viewer-ready', negotiationId: 'resume-1', payload: {} }],
            after: 1,
          });
        }
        return response(200, { messages: [], after: 1 });
      }
      if (url.endsWith('/signal')) return response(200, { accepted: true, sequence: 2 });
      if (url.endsWith('/leave')) return response(200, { left: true });
      return response(404, { error: { code: 'not_found' } });
    },
    RTCPeerConnectionImpl: FakePeerConnection,
    setTimer(fn, ms) { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimer(timer) { timer.cleared = true; },
  });

  transport.start();
  await flush(); await flush();
  const discoveryPoll = timers.find((timer) => timer.ms === 2_000 && !timer.cleared);
  discoveryPoll.cleared = true;
  await discoveryPoll.fn();
  await flush(); await flush();

  const peer = FakePeerConnection.instances[0];
  const negotiationTimeout = timers.find((timer) => timer.ms === 12_000 && !timer.cleared);
  assert.ok(negotiationTimeout);
  peer.channel.open({ markPeerConnected: false });

  assert.equal(peer.channel.sent[0].type, 'snapshot');
  assert.equal(negotiationTimeout.cleared, true, 'an open DataChannel must not be destroyed by negotiation timeout');
  for (let sequence = 1; sequence <= 20; sequence += 1) {
    assert.equal(transport.publishCue({
      cueId: `cue-${sequence}`, sessionId: 'session-1', segmentId: 'segment-2', sequence,
      sourceText: `source ${sequence}`, translatedText: `translation ${sequence}`,
    }), true);
  }
  assert.equal(peer.channel.sent.filter((packet) => packet.type === 'cue.append').length, 20);
  assert.equal(peer.closed, undefined);
  assert.equal(peer.channel.closed, false);
  await transport.stop();
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

test('cloud signaling heartbeat 503 preserves an open Viewer DataChannel and later Cue publishes', async () => {
  FakePeerConnection.instances = [];
  configureLivePipelineTrace(true);
  livePipelineTrace.clear();
  const timers = [];
  const statuses = [];
  let joins = 0;
  let deliveredReady = false;
  const transport = createWebRtcSubtitleTransport({
    meetingId: 'meeting-1', role: 'device', participantId: 'device-persistence-isolation',
    fetchImpl: async (url) => {
      if (url.endsWith('/join')) {
        joins += 1;
        if (joins === 2) return response(503, { error: { code: 'cloud_capability_unavailable' } });
        return response(200, { ttlMs: 12_000, iceServers: [] });
      }
      if (url.includes('/signal?')) {
        if (!deliveredReady) {
          deliveredReady = true;
          return response(200, {
            messages: [{ sequence: 1, participantId: 'viewer-1', type: 'viewer-ready', negotiationId: 'n-1', payload: {} }], after: 1
          });
        }
        return response(200, { messages: [], after: 1 });
      }
      if (url.endsWith('/signal')) return response(200, { accepted: true, sequence: 1 });
      if (url.endsWith('/leave')) return response(200, { left: true });
      return response(200, {});
    },
    RTCPeerConnectionImpl: FakePeerConnection,
    random: () => 0.5,
    setTimer(fn, ms) {
      const timer = { fn, ms, cleared: false, executed: false };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) { timer.cleared = true; },
    onStatus: (status) => statuses.push(status.value),
  });

  transport.start();
  await flush();
  await flush();
  const discoveryPoll = timers.find((timer) => timer.ms === 2_000 && !timer.cleared);
  discoveryPoll.executed = true;
  await discoveryPoll.fn();
  await flush();
  await flush();
  const peer = FakePeerConnection.instances[0];
  peer.channel.open();
  transport.publishCue({ cueId: 'cue-1', sessionId: 'session-1', segmentId: 'segment-1', sequence: 1, sourceText: 'one' });

  const heartbeat = timers.find((timer) => timer.ms === 6_000 && !timer.cleared);
  heartbeat.executed = true;
  await heartbeat.fn();
  await flush();

  assert.equal(peer.closed, undefined);
  assert.equal(peer.channel.closed, false);
  assert.equal(statuses.includes('reconnecting'), false);
  assert.equal(transport.publishCue({ cueId: 'cue-2', sessionId: 'session-1', segmentId: 'segment-1', sequence: 2, sourceText: 'two' }), true);

  const retryHeartbeat = timers.find((timer) => timer.ms === 5_000 && !timer.cleared && !timer.executed);
  assert.ok(retryHeartbeat);
  retryHeartbeat.executed = true;
  await retryHeartbeat.fn();
  await flush();
  assert.equal(joins, 3);
  assert.equal(transport.publishCue({ cueId: 'cue-3', sessionId: 'session-1', segmentId: 'segment-1', sequence: 3, sourceText: 'three' }), true);
  assert.deepEqual(
    peer.channel.sent.filter((packet) => packet.type === 'cue.append').map((packet) => packet.cue.cueId),
    ['cue-1', 'cue-2', 'cue-3']
  );
  assert.equal(livePipelineTrace.get({ stage: 'WEBRTC_SIGNALING' }).some((entry) => (
    entry.eventType === 'heartbeat.failed'
    && entry.decision === 'preserve_open_data_channel'
    && entry.errorCode === 'cloud_capability_unavailable'
  )), true);

  await transport.stop();
  configureLivePipelineTrace(false);
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
  assert.equal(statuses.at(-1), 'waiting');
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

test('successful Device joins reset recovery budget while no Viewer is connected', async () => {
  FakePeerConnection.instances = [];
  const timers = [];
  const statuses = [];
  let joins = 0;
  const transport = createWebRtcSubtitleTransport({
    meetingId: 'meeting-1', role: 'device', participantId: 'device-long-wait',
    fetchImpl: async (url) => {
      if (url.endsWith('/join')) {
        joins += 1;
        return joins % 2 === 0
          ? response(503, { error: { code: 'webrtc_signaling_unavailable' } })
          : response(200, { ttlMs: 60_000, iceServers: [] });
      }
      if (url.includes('/signal?')) return response(200, { messages: [], after: 0 });
      if (url.endsWith('/leave')) return response(200, { left: true });
      return response(200, { accepted: true, sequence: 1 });
    },
    RTCPeerConnectionImpl: FakePeerConnection,
    random: () => 0.5,
    setTimer(fn, ms) { const timer = { fn, ms, cleared: false, executed: false }; timers.push(timer); return timer; },
    clearTimer(timer) { timer.cleared = true; },
    onStatus: (status) => statuses.push(status),
  });

  transport.start();
  await flush(); await flush();
  for (let cycle = 0; cycle < MAX_RECOVERY_ATTEMPTS + 2; cycle += 1) {
    const heartbeat = timers.find((item) => item.ms === 30_000 && !item.cleared && !item.executed);
    assert.ok(heartbeat, `missing Device heartbeat for cycle ${cycle + 1}`);
    heartbeat.executed = true;
    await heartbeat.fn();
    await flush(); await flush();
    const retry = timers.find((item) => item.ms === 1_000 && !item.cleared && !item.executed);
    assert.ok(retry, `Device retry budget was not reset for cycle ${cycle + 1}`);
    retry.executed = true;
    await retry.fn();
    await flush(); await flush();
  }

  assert.equal(statuses.some(({ value }) => value === 'recovery_failed'), false);
  assert.equal(statuses.at(-1).value, 'waiting');
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
  assert.equal(statuses.at(-1).value, 'recovery_failed');
  assert.equal(statuses.at(-1).attemptCount, 6);
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
  try {
    await flush();
    assert.equal(statuses.at(-1).reason, 'network_offline');
    assert.equal(statuses.at(-1).attempt, 0);
    online = true;
    listeners.get('online')();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(joins, 2);
    assert.equal(FakePeerConnection.instances.length, 1);
  } finally {
    await transport.stop();
  }
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

test('Viewer retry exhaustion enters recovery_failed and records RECOVERY_EXHAUSTED', async () => {
  FakePeerConnection.instances = [];
  configureLivePipelineTrace(true);
  livePipelineTrace.clear();
  const timers = [];
  const statuses = [];
  const transport = createWebRtcSubtitleTransport({
    meetingId: 'meeting-1', role: 'viewer', participantId: 'viewer-exhausted', credential: { shareToken: 'token' },
    fetchImpl: async (url) => {
      if (url.endsWith('/join')) return response(503, { error: { code: 'cloud_capability_unavailable' } });
      if (url.endsWith('/leave')) return response(200, { left: true });
      return response(200, { messages: [], after: 0 });
    },
    RTCPeerConnectionImpl: FakePeerConnection,
    now: () => 123_456,
    random: () => 0.5,
    setTimer(fn, ms) { const timer = { fn, ms, cleared: false, executed: false }; timers.push(timer); return timer; },
    clearTimer(timer) { timer.cleared = true; },
    onStatus: (status) => statuses.push(status),
  });

  transport.start();
  await flush(); await flush();
  for (let attempt = 0; attempt < MAX_RECOVERY_ATTEMPTS; attempt += 1) {
    const retry = timers.find((timer) => !timer.cleared && !timer.executed);
    assert.ok(retry, `missing recovery timer for attempt ${attempt + 1}`);
    retry.executed = true;
    retry.cleared = true;
    await retry.fn();
    await flush(); await flush();
  }

  const failure = statuses.at(-1);
  assert.equal(failure.value, 'recovery_failed');
  assert.equal(failure.attemptCount, MAX_RECOVERY_ATTEMPTS);
  assert.equal(timers.filter((timer) => !timer.cleared && !timer.executed).length, 0);
  const exhausted = livePipelineTrace.get({ stage: 'WEBRTC_TRANSPORT_RECOVERY' })
    .find((entry) => entry.eventType === 'RECOVERY_EXHAUSTED');
  const scheduled = livePipelineTrace.get({ stage: 'WEBRTC_TRANSPORT_RECOVERY' })
    .filter((entry) => entry.eventType === 'RECOVERY_ATTEMPT_SCHEDULED');
  assert.equal(scheduled.length, MAX_RECOVERY_ATTEMPTS);
  assert.deepEqual(scheduled.map((entry) => entry.reconnectAttempt), [1, 2, 3, 4, 5, 6]);
  assert.equal(scheduled.every((entry) => entry.recoveryAttemptState === 'scheduled'), true);
  assert.equal(scheduled.every((entry) => entry.retryCounterSemantics === 'incremented_when_scheduled'), true);
  await transport.stop();
  configureLivePipelineTrace(false);
  assert.equal(Number.isInteger(exhausted.generation) && exhausted.generation > 0, true);
  assert.deepEqual({
    meetingId: exhausted.meetingId,
    viewerId: exhausted.viewerId,
    attemptCount: exhausted.attemptCount,
    reason: exhausted.reason,
    connectionState: exhausted.connectionState,
    iceConnectionState: exhausted.iceConnectionState,
    dataChannelState: exhausted.dataChannelState,
    timestamp: exhausted.timestamp,
  }, {
    meetingId: 'meeting-1',
    viewerId: 'viewer-exhausted',
    attemptCount: MAX_RECOVERY_ATTEMPTS,
    reason: 'retry_exhausted',
    connectionState: null,
    iceConnectionState: null,
    dataChannelState: null,
    timestamp: 123_456,
  });
  assert.equal(exhausted.recoveryAttemptState, 'exhausted');
  assert.equal(exhausted.retryCounterSemantics, 'incremented_when_scheduled');
});

test('transient Viewer signaling 503 does not fail a healthy DataChannel', async () => {
  FakePeerConnection.instances = [];
  const timers = [];
  const statuses = [];
  let joins = 0;
  const transport = createWebRtcSubtitleTransport({
    meetingId: 'meeting-1', role: 'viewer', participantId: 'viewer-transient-503', credential: { shareToken: 'token' },
    fetchImpl: async (url) => {
      if (url.endsWith('/join')) {
        joins += 1;
        if (joins === 2) return response(503, { error: { code: 'cloud_capability_unavailable' } });
        return response(200, { ttlMs: 12_000, iceServers: [] });
      }
      if (url.endsWith('/signal')) return response(200, { accepted: true, sequence: 1 });
      if (url.endsWith('/leave')) return response(200, { left: true });
      return response(200, { messages: [], after: 0 });
    },
    RTCPeerConnectionImpl: FakePeerConnection,
    random: () => 0.5,
    setTimer(fn, ms) { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimer(timer) { timer.cleared = true; },
    onStatus: (status) => statuses.push(status.value),
  });

  transport.start();
  await flush(); await flush();
  const peer = FakePeerConnection.instances[0];
  const channel = new FakeDataChannel(peer);
  peer.ondatachannel({ channel });
  channel.open();
  const heartbeat = timers.find((timer) => timer.ms === 6_000 && !timer.cleared);
  assert.ok(heartbeat);
  await heartbeat.fn();
  await flush();

  assert.equal(channel.readyState, 'open');
  assert.equal(statuses.includes('recovery_failed'), false);
  assert.equal(statuses.at(-1), 'connected');
  await transport.stop();
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
