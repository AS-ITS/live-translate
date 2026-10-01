import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebRtcSignalingClient } from '../../src/webrtc/signalingClient.js';
import { createWebRtcSubtitleTransport } from '../../src/webrtc/subtitleTransport.js';

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
  close() { this.closed = true; }
}

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
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

test('failed Device signaling schedules reconnect without rejecting recording startup', async () => {
  const statuses = [];
  const timers = [];
  const transport = createWebRtcSubtitleTransport({
    meetingId: 'meeting-1',
    role: 'device',
    participantId: 'device-1',
    fetchImpl: async () => response(503, { error: { code: 'webrtc_signaling_unavailable' } }),
    RTCPeerConnectionImpl: FakePeerConnection,
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
