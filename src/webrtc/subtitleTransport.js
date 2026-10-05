import { createReplayRequest, createSubtitleDataChannelAdapter, createSubtitleSource, SUBTITLE_ENVELOPE_TYPES } from './subtitleDataChannel.js';
import { createWebRtcSignalingClient } from './signalingClient.js';
import { recordLivePipelineTrace } from '../lib/livePipelineTrace.js';

const RETRY_DELAYS_MS = Object.freeze([1_000, 2_000, 4_000, 8_000, 10_000, 10_000]);
const DISCONNECTED_GRACE_MS = 5_000;
const ICE_RESTART_TIMEOUT_MS = 10_000;
const NEGOTIATION_TIMEOUT_MS = 12_000;
const CONNECTED_POLL_INTERVAL_MS = 2_000;

export function createWebRtcSubtitleTransport({
  meetingId,
  role,
  credential,
  participantId = createParticipantId(role),
  fetchImpl = globalThis.fetch,
  RTCPeerConnectionImpl = globalThis.RTCPeerConnection,
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout,
  pollIntervalMs = 250,
  random = Math.random,
  lifecycleTarget = globalThis.window,
  documentRef = globalThis.document,
  isOnline = () => globalThis.navigator?.onLine !== false,
  initialCues = [],
  onStatus,
  onEnvelope,
  onError,
} = {}) {
  if (!meetingId || !['device', 'viewer'].includes(role) || typeof RTCPeerConnectionImpl !== 'function') {
    throw new TypeError('WebRTC subtitle transport requires meetingId, role, and RTCPeerConnection.');
  }
  const client = createWebRtcSignalingClient({ meetingId, participantId, role, credential, fetchImpl });
  const source = role === 'device' ? createSubtitleSource({ meetingId, maxHistory: 500 }) : null;
  const cueVersions = new Map();
  let active = null;
  const devicePeers = new Map();
  let devicePollTimer = null;
  let devicePollAfter = 0;
  let devicePollFailures = 0;
  let joined = false;
  let iceServers = [];
  let heartbeatTimer = null;
  let reconnectTimer = null;
  let connectionEpoch = 0;
  let retryAttempt = 0;
  let stopped = false;
  let hadOutage = false;
  let waitingForOnline = false;
  let listenersAttached = false;
  let lastSourceId = null;
  let lastSourceSequence = 0;

  initialCues.forEach(publishCue);

  function status(value, details = {}) {
    recordLivePipelineTrace({
      stage: 'WEBRTC_TRANSPORT',
      connectionEpoch: details.epoch ?? connectionEpoch,
      eventType: role,
      eventSequence: details.attempt ?? null,
      reason: details.reason || value,
      decision: details.recovered ? 'recovered' : null,
      transportResult: value,
    });
    onStatus?.(Object.freeze({ value, ...details }));
  }

  function isCurrent(context) {
    return !stopped && context.epoch === connectionEpoch
      && (role === 'device' ? devicePeers.get(context.viewerId) === context : active === context);
  }

  function clearContextTimer(context, key) {
    if (context?.[key]) clearTimer(context[key]);
    if (context) context[key] = null;
  }

  function cleanupPeer(context = active) {
    if (!context) return;
    if (active === context) active = null;
    clearContextTimer(context, 'pollTimer');
    clearContextTimer(context, 'disconnectTimer');
    clearContextTimer(context, 'iceRestartTimer');
    clearContextTimer(context, 'negotiationTimer');
    if (context.viewerId && devicePeers.get(context.viewerId) === context) devicePeers.delete(context.viewerId);
    context.pendingCandidates = [];
    context.adapter?.close();
    context.adapter = null;
    context.channel = null;
    context.pc?.close?.();
  }

  function cleanupAllPeers() {
    cleanupPeer();
    for (const context of [...devicePeers.values()]) cleanupPeer(context);
  }

  function clearDevicePoll() {
    if (devicePollTimer) clearTimer(devicePollTimer);
    devicePollTimer = null;
  }

  function clearHeartbeat() {
    if (heartbeatTimer) clearTimer(heartbeatTimer);
    heartbeatTimer = null;
  }

  function scheduleHeartbeat(ttlMs, epoch) {
    clearHeartbeat();
    if (stopped || epoch !== connectionEpoch) return;
    const interval = Math.min(30_000, Math.max(5_000, Math.floor((Number(ttlMs) || 60_000) / 2)));
    heartbeatTimer = setTimer(async () => {
      heartbeatTimer = null;
      if (stopped || epoch !== connectionEpoch) return;
      try {
        const joined = await client.join();
        if (stopped || epoch !== connectionEpoch) return;
        scheduleHeartbeat(joined.ttlMs, epoch);
      } catch (error) {
        if (stopped || epoch !== connectionEpoch) return;
        handleConnectError(error, 'heartbeat_failed');
      }
    }, interval);
  }

  async function connect({ reconnecting = false } = {}) {
    cleanupAllPeers();
    clearDevicePoll();
    clearHeartbeat();
    joined = false;
    devicePollAfter = 0;
    devicePollFailures = 0;
    const epoch = ++connectionEpoch;
    status(reconnecting ? 'reconnecting' : 'connecting', { epoch, attempt: retryAttempt });
    try {
      const joinResult = await client.join();
      if (stopped || epoch !== connectionEpoch) return;
      joined = true;
      iceServers = joinResult.iceServers || [];
      scheduleHeartbeat(joinResult.ttlMs, epoch);
      if (role === 'device') {
        status('waiting', { epoch });
        scheduleDevicePoll(epoch);
        return;
      }
      const context = {
        epoch,
        negotiationId: createIdentifier('negotiation'),
        pc: new RTCPeerConnectionImpl({ iceServers }),
        adapter: null,
        channel: null,
        pollTimer: null,
        disconnectTimer: null,
        iceRestartTimer: null,
        negotiationTimer: null,
        pollAfter: 0,
        pollFailures: 0,
        connected: false,
        pendingCandidates: [],
      };
      active = context;
      wirePeer(context);
      await client.signal('viewer-ready', {}, { negotiationId: context.negotiationId });
      if (!isCurrent(context)) return;
      status('waiting', { epoch, negotiationId: context.negotiationId });
      context.negotiationTimer = setTimer(() => {
        context.negotiationTimer = null;
        if (isCurrent(context) && !context.connected) scheduleReconnect('negotiation_timeout');
      }, NEGOTIATION_TIMEOUT_MS);
      schedulePoll(context);
    } catch (error) {
      if (stopped || epoch !== connectionEpoch) return;
      handleConnectError(error, 'connect_failed');
    }
  }

  function wirePeer(context) {
    context.pc.onicecandidate = ({ candidate }) => {
      if (!candidate || !isCurrent(context) || !context.peerId) return;
      void client.signal('ice-candidate', candidate, {
        targetParticipantId: context.peerId, negotiationId: context.negotiationId,
      }).catch((error) => { if (isCurrent(context)) handleAsyncError(error); });
    };
    context.pc.onconnectionstatechange = () => {
      if (!isCurrent(context)) return;
      if (context.pc.connectionState === 'connected') {
        clearContextTimer(context, 'disconnectTimer');
        clearContextTimer(context, 'iceRestartTimer');
        if (context.channel?.readyState === 'open') markConnected(context);
      } else if (context.pc.connectionState === 'disconnected') {
        context.connected = false;
        scheduleDisconnectedRecovery(context);
        if (role === 'viewer') schedulePoll(context);
      } else if (context.pc.connectionState === 'failed') {
        if (role === 'device') cleanupDevicePeer(context);
        else scheduleReconnect('peer_failed');
      }
    };
    context.pc.ondatachannel = ({ channel }) => wireChannel(context, channel);
  }

  function markConnected(context) {
    context.connected = true;
    clearContextTimer(context, 'negotiationTimer');
    clearContextTimer(context, 'disconnectTimer');
    clearContextTimer(context, 'iceRestartTimer');
    retryAttempt = 0;
    status(hadOutage ? 'restored' : 'connected', { epoch: context.epoch, recovered: hadOutage });
    hadOutage = false;
  }

  function wireChannel(context, nextChannel) {
    if (!isCurrent(context)) return;
    context.channel = nextChannel;
    context.adapter = createSubtitleDataChannelAdapter(nextChannel, {
      onEnvelope: (envelope) => {
        if (!isCurrent(context)) return;
        if (role === 'device' && envelope.type === SUBTITLE_ENVELOPE_TYPES.replayRequest) {
          context.adapter?.send(source.replay(envelope));
          return;
        }
        if (role === 'viewer') {
          rememberViewerCursor(envelope);
          onEnvelope?.(envelope);
        }
      },
      onError: (error) => { if (isCurrent(context)) handleAsyncError(error); },
    });
    nextChannel.onopen = () => {
      if (!isCurrent(context)) return;
      markConnected(context);
      if (role === 'device') context.adapter.send(source.snapshot());
      else context.adapter.send(createReplayRequest({
        meetingId,
        requestId: createIdentifier('replay'),
        ...(lastSourceId ? { sourceId: lastSourceId } : {}),
        afterSequence: lastSourceSequence,
      }));
    };
    nextChannel.onclose = () => {
      if (!isCurrent(context)) return;
      if (role === 'device') cleanupDevicePeer(context);
      else scheduleReconnect('data_channel_closed');
    };
    nextChannel.onerror = (error) => {
      if (!isCurrent(context)) return;
      handleAsyncError(error);
      if (role === 'device') cleanupDevicePeer(context);
      else scheduleReconnect('data_channel_error');
    };
  }

  function cleanupDevicePeer(context) {
    cleanupPeer(context);
    if (devicePeers.size === 0 && !stopped) {
      hadOutage = true;
      status('reconnecting', { epoch: connectionEpoch, reason: 'device_peer_closed' });
    }
  }

  async function createDevicePeer(viewerId, negotiationId, epoch) {
    if (stopped || epoch !== connectionEpoch || !viewerId || !negotiationId) return;
    const previous = devicePeers.get(viewerId);
    if (previous?.negotiationId === negotiationId && previous.connected) return;
    if (previous) cleanupPeer(previous);
    const context = {
      epoch, viewerId, peerId: viewerId, negotiationId,
      pc: new RTCPeerConnectionImpl({ iceServers }), adapter: null, channel: null,
      pollTimer: null, disconnectTimer: null, iceRestartTimer: null, negotiationTimer: null,
      connected: false, pendingCandidates: [],
    };
    devicePeers.set(viewerId, context);
    wirePeer(context);
    wireChannel(context, context.pc.createDataChannel('subtitles'));
    try {
      const offer = await context.pc.createOffer();
      if (!isCurrent(context)) return;
      await context.pc.setLocalDescription(offer);
      if (!isCurrent(context)) return;
      await client.signal('offer', context.pc.localDescription, {
        targetParticipantId: viewerId, negotiationId,
      });
      if (!isCurrent(context)) return;
      context.negotiationTimer = setTimer(() => {
        context.negotiationTimer = null;
        if (isCurrent(context) && !context.connected) cleanupDevicePeer(context);
      }, NEGOTIATION_TIMEOUT_MS);
    } catch (error) {
      if (isCurrent(context)) {
        handleAsyncError(error);
        cleanupDevicePeer(context);
      }
    }
  }

  function scheduleDevicePoll(epoch, delay = CONNECTED_POLL_INTERVAL_MS) {
    if (stopped || epoch !== connectionEpoch || devicePollTimer) return;
    devicePollTimer = setTimer(async () => {
      devicePollTimer = null;
      if (stopped || epoch !== connectionEpoch) return;
      try {
        const result = await client.poll(devicePollAfter);
        if (stopped || epoch !== connectionEpoch) return;
        devicePollFailures = 0;
        for (const message of result.messages || []) {
          devicePollAfter = Math.max(devicePollAfter, Number(message.sequence) || 0);
          if (message.type === 'viewer-ready') {
            await createDevicePeer(message.participantId, message.negotiationId, epoch);
          } else {
            const context = devicePeers.get(message.participantId);
            if (context?.negotiationId === message.negotiationId) await handleSignal(context, message);
          }
          if (stopped || epoch !== connectionEpoch) return;
        }
        devicePollAfter = Math.max(devicePollAfter, Number(result.after) || 0);
      } catch (error) {
        if (stopped || epoch !== connectionEpoch) return;
        if (isTerminalError(error) || error?.code === 'participant_unauthorized') {
          handleConnectError(error, 'device_poll_failed');
          return;
        }
        handleAsyncError(error);
        devicePollFailures = Math.min(devicePollFailures + 1, RETRY_DELAYS_MS.length);
      }
      const nextDelay = devicePollFailures
        ? jitter(RETRY_DELAYS_MS[devicePollFailures - 1], random)
        : CONNECTED_POLL_INTERVAL_MS;
      scheduleDevicePoll(epoch, nextDelay);
    }, delay);
  }

  function schedulePoll(context, delay = null) {
    if (!isCurrent(context) || context.pollTimer) return;
    context.pollTimer = setTimer(async () => {
      context.pollTimer = null;
      if (!isCurrent(context)) return;
      try {
        const result = await client.poll(context.pollAfter);
        if (!isCurrent(context)) return;
        context.pollFailures = 0;
        for (const message of result.messages || []) {
          context.pollAfter = Math.max(context.pollAfter, Number(message.sequence) || 0);
          await handleSignal(context, message);
          if (!isCurrent(context)) return;
        }
        context.pollAfter = Math.max(context.pollAfter, Number(result.after) || 0);
      } catch (error) {
        if (!isCurrent(context)) return;
        if (isTerminalError(error) || error?.code === 'participant_unauthorized') {
          handleConnectError(error, 'poll_terminal');
          return;
        }
        handleAsyncError(error);
        context.pollFailures = Math.min(context.pollFailures + 1, RETRY_DELAYS_MS.length);
      }
      const delay = context.pollFailures
        ? jitter(RETRY_DELAYS_MS[context.pollFailures - 1], random)
        : (context.connected ? CONNECTED_POLL_INTERVAL_MS : pollIntervalMs);
      schedulePoll(context, delay);
    }, delay ?? (context.connected ? CONNECTED_POLL_INTERVAL_MS : pollIntervalMs));
  }

  async function handleSignal(context, message) {
    if (!isCurrent(context) || message.negotiationId !== context.negotiationId) return;
    const peer = context.pc;
    if (message.type === 'offer' && role === 'viewer') {
      if (message.targetParticipantId !== participantId) return;
      context.peerId = message.participantId;
      await peer.setRemoteDescription(message.payload);
      if (!isCurrent(context)) return;
      await flushCandidates(context);
      if (!isCurrent(context)) return;
      const answer = await peer.createAnswer();
      if (!isCurrent(context)) return;
      await peer.setLocalDescription(answer);
      if (!isCurrent(context)) return;
      await client.signal('answer', peer.localDescription, {
        targetParticipantId: context.peerId, negotiationId: context.negotiationId,
      });
      return;
    }
    if (message.type === 'answer' && role === 'device') {
      await peer.setRemoteDescription(message.payload);
      if (!isCurrent(context)) return;
      await flushCandidates(context);
      return;
    }
    if (message.type === 'ice-candidate') {
      if (context.peerId && message.participantId !== context.peerId) return;
      if (peer.remoteDescription) await peer.addIceCandidate(message.payload);
      else context.pendingCandidates.push(message.payload);
    }
  }

  async function flushCandidates(context) {
    const candidates = context.pendingCandidates;
    context.pendingCandidates = [];
    for (const candidate of candidates) {
      if (!isCurrent(context)) return;
      await context.pc.addIceCandidate(candidate);
    }
  }

  function scheduleDisconnectedRecovery(context) {
    if (!isCurrent(context) || context.disconnectTimer) return;
    hadOutage = true;
    if (role === 'viewer' || ![...devicePeers.values()].some((peer) => peer !== context && peer.connected)) {
      status('reconnecting', { epoch: context.epoch, reason: 'peer_disconnected', graceMs: DISCONNECTED_GRACE_MS });
    }
    context.disconnectTimer = setTimer(async () => {
      context.disconnectTimer = null;
      if (!isCurrent(context) || context.pc.connectionState === 'connected') return;
      hadOutage = true;
      if (role !== 'device') {
        scheduleReconnect('disconnected_timeout', { immediate: true });
        return;
      }
      try {
        context.pc.restartIce?.();
        const offer = await context.pc.createOffer({ iceRestart: true });
        if (!isCurrent(context)) return;
        await context.pc.setLocalDescription(offer);
        if (!isCurrent(context)) return;
        await client.signal('offer', context.pc.localDescription, {
          targetParticipantId: context.viewerId, negotiationId: context.negotiationId,
        });
        if (!isCurrent(context)) return;
        status('reconnecting', { epoch: context.epoch, reason: 'ice_restart', attempt: retryAttempt });
        context.iceRestartTimer = setTimer(() => {
          context.iceRestartTimer = null;
          if (isCurrent(context) && context.pc.connectionState !== 'connected') {
            cleanupDevicePeer(context);
          }
        }, ICE_RESTART_TIMEOUT_MS);
      } catch (error) {
        if (!isCurrent(context)) return;
        handleAsyncError(error);
        cleanupDevicePeer(context);
      }
    }, DISCONNECTED_GRACE_MS);
  }

  function handleConnectError(error, reason = 'signaling_failed') {
    const code = error?.code || 'webrtc_signaling_unavailable';
    if (code === 'meeting_stopped' || code === 'meeting_revoked') {
      terminateTransport();
      status('stopped', { code });
      onError?.(error);
      return;
    }
    if (code === 'share_unauthorized') {
      terminateTransport();
      status('invalid', { code });
      onError?.(error);
      return;
    }
    onError?.(error);
    scheduleReconnect(reason);
  }

  function handleAsyncError(error) {
    if (!stopped) onError?.(error);
  }

  function scheduleReconnect(reason = 'transport_interrupted', { immediate = false } = {}) {
    if (stopped || reconnectTimer) return;
    hadOutage = true;
    clearHeartbeat();
    clearDevicePoll();
    cleanupAllPeers();
    joined = false;
    if (!isOnline()) {
      waitingForOnline = true;
      status('reconnecting', { reason: 'network_offline', attempt: retryAttempt });
      return;
    }
    if (retryAttempt >= RETRY_DELAYS_MS.length) {
      status('failed', { reason: 'retry_exhausted', attempts: retryAttempt });
      return;
    }
    const attempt = retryAttempt + 1;
    const delay = immediate ? 0 : jitter(RETRY_DELAYS_MS[retryAttempt], random);
    retryAttempt = attempt;
    status('reconnecting', { reason, attempt, delay });
    reconnectTimer = setTimer(() => {
      reconnectTimer = null;
      void connect({ reconnecting: true });
    }, delay);
  }

  function terminateTransport() {
    stopped = true;
    connectionEpoch += 1;
    clearHeartbeat();
    clearDevicePoll();
    if (reconnectTimer) clearTimer(reconnectTimer);
    reconnectTimer = null;
    cleanupAllPeers();
    joined = false;
    detachLifecycleListeners();
  }

  function rememberViewerCursor(envelope) {
    if (typeof envelope?.sourceId === 'string' && envelope.sourceId.length > 0) {
      if (lastSourceId !== envelope.sourceId) lastSourceSequence = 0;
      lastSourceId = envelope.sourceId;
    }
    if (lastSourceId && envelope?.sourceId === lastSourceId) {
      lastSourceSequence = Math.max(lastSourceSequence, Number(envelope.sequence) || 0, Number(envelope.toSequence) || 0);
    }
  }

  function resumeFromLifecycle() {
    if (stopped || !isOnline() || documentRef?.visibilityState === 'hidden') return;
    if (!waitingForOnline && !hadOutage && (role === 'device' ? joined : active?.connected)) return;
    waitingForOnline = false;
    if (reconnectTimer) clearTimer(reconnectTimer);
    reconnectTimer = null;
    hadOutage = true;
    void connect({ reconnecting: true });
  }

  function handleVisibilityChange() {
    if (documentRef?.visibilityState !== 'hidden') resumeFromLifecycle();
  }

  function attachLifecycleListeners() {
    if (listenersAttached || !lifecycleTarget?.addEventListener) return;
    listenersAttached = true;
    lifecycleTarget.addEventListener('online', resumeFromLifecycle);
    lifecycleTarget.addEventListener('pageshow', resumeFromLifecycle);
    documentRef?.addEventListener?.('visibilitychange', handleVisibilityChange);
  }

  function detachLifecycleListeners() {
    if (!listenersAttached) return;
    listenersAttached = false;
    lifecycleTarget?.removeEventListener?.('online', resumeFromLifecycle);
    lifecycleTarget?.removeEventListener?.('pageshow', resumeFromLifecycle);
    documentRef?.removeEventListener?.('visibilitychange', handleVisibilityChange);
  }

  function publishCue(cue) {
    if (!source || !cue?.cueId) return false;
    const serialized = JSON.stringify(cue);
    const previous = cueVersions.get(cue.cueId);
    if (previous?.serialized === serialized) return false;
    const revision = (previous?.revision || 0) + 1;
    const normalized = { ...cue, meetingId, revision: Math.max(Number(cue.revision) || 0, revision) };
    const envelope = previous ? source.update(normalized) : source.append(normalized);
    cueVersions.set(cue.cueId, { serialized, revision: normalized.revision });
    let sent = false;
    for (const context of devicePeers.values()) sent = Boolean(context.adapter?.send(envelope)) || sent;
    return sent;
  }

  return Object.freeze({
    participantId,
    async getStats() {
      const contexts = role === 'device' ? [...devicePeers.values()] : [active];
      const reports = await Promise.all(contexts.filter((context) => typeof context?.pc?.getStats === 'function')
        .map((context) => context.pc.getStats()));
      return reports.flatMap(candidatePairEvidence);
    },
    start() {
      stopped = false;
      retryAttempt = 0;
      attachLifecycleListeners();
      void connect();
    },
    retry() {
      stopped = false;
      retryAttempt = 0;
      hadOutage = true;
      waitingForOnline = false;
      if (reconnectTimer) clearTimer(reconnectTimer);
      reconnectTimer = null;
      attachLifecycleListeners();
      void connect({ reconnecting: true });
    },
    publishCue,
    async stop({ revoke = false } = {}) {
      stopped = true;
      connectionEpoch += 1;
      clearHeartbeat();
      clearDevicePoll();
      if (reconnectTimer) clearTimer(reconnectTimer);
      reconnectTimer = null;
      waitingForOnline = false;
      if (revoke && role === 'device') {
        for (const context of devicePeers.values()) {
          context.adapter?.send({ protocol: 'subtitle-webrtc/v1', type: SUBTITLE_ENVELOPE_TYPES.meetingStopped, meetingId });
        }
      }
      cleanupAllPeers();
      joined = false;
      detachLifecycleListeners();
      try {
        if (revoke && role === 'device') await client.stop();
        else await client.leave();
      } catch {
        // Participant TTL provides eventual cleanup when the page is already offline.
      }
      status('idle');
    },
  });
}

function isTerminalError(error) {
  return ['meeting_stopped', 'meeting_revoked', 'share_unauthorized'].includes(error?.code);
}

function jitter(delay, random) {
  const sample = Math.min(1, Math.max(0, Number(random?.()) || 0));
  return Math.round(delay * (0.75 + sample * 0.5));
}

function createIdentifier(prefix) {
  return globalThis.crypto?.randomUUID?.() || `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function candidatePairEvidence(stats) {
  if (!stats || typeof stats.values !== 'function' || typeof stats.get !== 'function') return [];
  return [...stats.values()]
    .filter((item) => item?.type === 'candidate-pair' && (item.selected || item.nominated))
    .map((pair) => ({
      pairId: pair.id,
      state: pair.state,
      selected: Boolean(pair.selected),
      nominated: Boolean(pair.nominated),
      localCandidateType: stats.get(pair.localCandidateId)?.candidateType || 'unknown',
      remoteCandidateType: stats.get(pair.remoteCandidateId)?.candidateType || 'unknown',
      currentRoundTripTime: Number.isFinite(pair.currentRoundTripTime) ? pair.currentRoundTripTime : null,
      timestamp: pair.timestamp,
    }));
}

function createParticipantId(role) {
  const suffix = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${role}-${suffix}`;
}
