export async function installHostViewerHarness(page, { code, meetingId, meetingName = 'Viewer test', cues = [], segments = [], lifecycle } = {}) {
  const state = { joins: 0, ready: 0, metadataReads: 0, cloudContentReads: 0,
    hostAvailable: true, lifecycleVersion: 1, recordingState: 'active', ...lifecycle };
  const initialCues = cues.map((cue) => ({ ...cue, meetingId,
    sessionId: cue.sessionId || segments.find((segment) => segment.id === cue.segmentId)?.sessionId }));
  await page.addInitScript(({ meetingId: id, initialCues: initial }) => {
    const nativeTimeout = window.setTimeout.bind(window);
    window.setTimeout = (callback, delay = 0, ...args) => nativeTimeout(callback,
      delay >= 1_000 && delay <= 15_000 ? 15 : delay, ...args);
    class Channel {
      constructor() { this.readyState = 'connecting'; this.listeners = new Map(); this.sent = []; }
      addEventListener(type, handler) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(handler); }
      emit(type, event = new Event(type)) { this.listeners.get(type)?.forEach((handler) => handler(event)); this[`on${type}`]?.(event); }
      open() { this.readyState = 'open'; this.emit('open'); }
      send(value) {
        const packet = JSON.parse(value);
        this.sent.push(packet);
        if (packet.type === 'replay.request' && window.__hostAvailable) {
          queueMicrotask(() => this.receive({ protocol: 'subtitle-webrtc/v1', type: 'snapshot',
            meetingId: id, sourceId: window.__hostSourceId, sequence: window.__hostSequence, cues: window.__hostCues }));
        }
      }
      receive(packet) { this.emit('message', new MessageEvent('message', { data: JSON.stringify(packet) })); }
      close() { if (this.readyState === 'closed') return; this.readyState = 'closed'; this.emit('close'); }
    }
    window.__hostChannels = [];
    // The Host fixture survives a Viewer page reload, just as a separate Host tab does.
    const persisted = sessionStorage.getItem(`host-fixture-${id}`);
    const hostState = persisted ? JSON.parse(persisted) : { cues: initial, sequence: initial.length };
    window.__hostCues = hostState.cues;
    window.__hostSequence = hostState.sequence;
    window.__hostSourceId = 'host-source-1';
    window.__hostAvailable = true;
    window.__hostPublish = (cue, type = 'cue.append') => {
      const index = window.__hostCues.findIndex((item) => item.cueId === cue.cueId);
      if (index < 0) window.__hostCues.push(cue);
      else window.__hostCues[index] = cue;
      const packet = { protocol: 'subtitle-webrtc/v1', type, meetingId: id,
        sourceId: window.__hostSourceId, sequence: ++window.__hostSequence, cue };
      sessionStorage.setItem(`host-fixture-${id}`, JSON.stringify({ cues: window.__hostCues, sequence: window.__hostSequence }));
      window.__hostChannels.at(-1)?.receive(packet);
      return packet;
    };
    window.__hostClose = () => window.__hostChannels.at(-1)?.close();
    window.__hostReceive = (packet) => window.__hostChannels.at(-1)?.receive(packet);
    window.__hostReload = () => { window.__hostSourceId = `host-source-${Date.now()}`; window.__hostSequence = window.__hostCues.length; window.__hostClose(); };
    window.RTCPeerConnection = class HostViewerPeerConnection {
      constructor() { this.connectionState = 'connecting'; this.iceConnectionState = 'checking'; this.signalingState = 'stable'; }
      async setRemoteDescription(description) {
        this.remoteDescription = description;
        const channel = new Channel();
        window.__hostChannels.push(channel);
        queueMicrotask(() => { this.ondatachannel?.({ channel }); channel.open();
          this.connectionState = 'connected'; this.iceConnectionState = 'connected'; this.onconnectionstatechange?.(); });
      }
      async createAnswer() { return { type: 'answer', sdp: 'host-viewer-answer' }; }
      async setLocalDescription(description) { this.localDescription = description; }
      async addIceCandidate() {}
      async getStats() { return new Map(); }
      close() { this.connectionState = 'closed'; }
    };
  }, { meetingId, initialCues });

  await page.route(`**/api/shared-meetings/code/${code}**`, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (!pathname.endsWith('/metadata')) {
      state.cloudContentReads += 1;
      await route.fulfill({ status: 599, json: { error: { code: 'cloud_content_forbidden' } } });
      return;
    }
    state.metadataReads += 1;
    if (state.retentionExpired) {
      await route.fulfill({ status: 410, json: { error: { code: 'meeting_content_expired' } } });
      return;
    }
    await route.fulfill({ json: { recordKind: 'meetingViewerMetadata',
      capability: { role: 'viewer', meetingId },
      meeting: { id: meetingId, name: meetingName, status: state.recordingState === 'ended' ? 'completed' : 'active',
        lifecycleVersion: state.lifecycleVersion }, recordingState: state.recordingState,
      segments: state.segments || segments } });
  });
  let signalSequence = 0;
  let negotiation = null;
  const offered = new Set();
  await page.route(`**/api/webrtc/${meetingId}/**`, async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname.endsWith('/join')) {
      state.joins += 1;
      await route.fulfill(state.joinFailure
        ? { status: 503, json: { error: { code: 'webrtc_signaling_unavailable' } } }
        : { json: { ttlMs: 60_000, iceServers: [] } });
      return;
    }
    if (pathname.endsWith('/signal') && request.method() === 'POST') {
      const body = request.postDataJSON();
      if (body.type === 'viewer-ready') { state.ready += 1; negotiation = body; }
      await route.fulfill({ json: { accepted: true, sequence: ++signalSequence } }); return;
    }
    if (pathname.endsWith('/signal')) {
      const sendOffer = state.recordingState === 'active' && state.hostAvailable
        && negotiation && !offered.has(negotiation.negotiationId);
      const messages = sendOffer ? [{ sequence: ++signalSequence, participantId: 'host-1',
        targetParticipantId: negotiation.participantId, negotiationId: negotiation.negotiationId,
        type: 'offer', payload: { type: 'offer', sdp: 'host-offer' } }] : [];
      if (sendOffer) offered.add(negotiation.negotiationId);
      await route.fulfill({ json: { messages, after: signalSequence } }); return;
    }
    await route.fulfill({ json: { left: true } });
  });
  return state;
}
