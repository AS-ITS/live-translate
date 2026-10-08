import { createEnvelope, createReplayRequest, createSubtitleDataChannelAdapter, createSubtitleSource, SUBTITLE_ENVELOPE_TYPES } from './subtitleDataChannel.js';
import { createWebRtcSignalingClient } from './signalingClient.js';
import { recordLivePipelineTrace } from '../lib/livePipelineTrace.js';

const RETRY_DELAYS_MS = Object.freeze([1_000, 2_000, 4_000, 8_000, 10_000, 10_000]);
export const MAX_RECOVERY_ATTEMPTS = RETRY_DELAYS_MS.length;
const DISCONNECTED_GRACE_MS = 5_000;
const ICE_RESTART_TIMEOUT_MS = 10_000;
const NEGOTIATION_TIMEOUT_MS = 12_000;
const CONNECTED_POLL_INTERVAL_MS = 2_000;
const HEARTBEAT_RETRY_INTERVAL_MS = 5_000;
const DATA_CHANNEL_PING_INTERVAL_MS = 10_000;
const DATA_CHANNEL_LIVENESS_TIMEOUT_MS = 25_000;

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
  now = Date.now,
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
  let signalingHealth = 'connecting';

  initialCues.forEach(publishCue);

  function status(value, details = {}) {
    const peerCounts = currentPeerCounts();
    const traceDetails = {
      stage: 'WEBRTC_TRANSPORT',
      meetingId,
      connectionEpoch: details.epoch ?? connectionEpoch,
      eventType: role,
      eventSequence: details.attempt ?? null,
      reason: details.reason || value,
      decision: details.recovered ? 'recovered' : null,
      connectionState: active?.pc?.connectionState,
      iceConnectionState: active?.pc?.iceConnectionState,
      dataChannelState: active?.channel?.readyState,
      realtimeState: value,
      transportResult: value,
      signalingHealth,
      ...peerCounts,
    };
    recordLivePipelineTrace(traceDetails);
    recordLivePipelineTrace({ ...traceDetails, stage: 'VIEWER_SHARING_STATE_CHANGED' });
    onStatus?.(Object.freeze({ value, signalingHealth, ...peerCounts, ...details }));
  }

  function trace(stage, eventType, context = null, details = {}) {
    const traceDetails = {
      stage,
      meetingId,
      participantId,
      connectionEpoch: context?.epoch ?? details.epoch ?? connectionEpoch,
      negotiationId: context?.negotiationId,
      eventType,
      connectionState: context?.pc?.connectionState,
      iceConnectionState: context?.pc?.iceConnectionState,
      signalingState: context?.pc?.signalingState,
      dataChannelState: context?.channel?.readyState,
      peerId: context?.peerId || context?.viewerId,
      lastDataChannelMessageAt: context?.lastDataChannelMessageAt,
      lastCueReceivedAt: context?.lastCueReceivedAt,
      lastPingAt: context?.lastPingAt,
      lastPongAt: context?.lastPongAt,
      signalingHealth,
      ...details,
    };
    recordLivePipelineTrace(traceDetails);
    if (stage === 'WEBRTC_PEER_STATE') {
      recordLivePipelineTrace({ ...traceDetails, stage: 'WEBRTC_STATE_CHANGED' });
    } else if (stage === 'WEBRTC_DATA_CHANNEL') {
      recordLivePipelineTrace({ ...traceDetails, stage: 'DATACHANNEL_STATE_CHANGED' });
    }
  }

  function recoveryTrace(eventType, context = null, details = {}) {
    trace('WEBRTC_TRANSPORT_RECOVERY', eventType, context, details);
  }

  function currentPeerCounts() {
    const contexts = role === 'device' ? [...devicePeers.values()] : (active ? [active] : []);
    return {
      peerCount: contexts.length,
      healthyPeerCount: contexts.filter(isTransportHealthy).length,
    };
  }

  function isTransportHealthy(context) {
    return Boolean(context
      && context.pc?.connectionState === 'connected'
      && !['disconnected', 'failed', 'closed'].includes(context.pc?.iceConnectionState)
      && context.channel?.readyState === 'open');
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
    clearContextTimer(context, 'livenessTimer');
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

  function clearReconnect() {
    if (reconnectTimer) clearTimer(reconnectTimer);
    reconnectTimer = null;
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
        if (signalingHealth !== 'healthy') {
          signalingHealth = 'healthy';
          recoveryTrace('SIGNALING_RECOVERED', null, { epoch, reason: 'heartbeat_join_succeeded' });
          if (hasOpenDataChannel()) status('connected', { epoch, reason: 'signaling_recovered' });
        }
        scheduleHeartbeat(joined.ttlMs, epoch);
      } catch (error) {
        if (stopped || epoch !== connectionEpoch) return;
        signalingHealth = 'recovering';
        recoveryTrace('SIGNALING_FAILURE', null, {
          epoch, reason: error?.code || 'heartbeat_failed', httpStatus: error?.status,
        });
        if (hasOpenDataChannel() && !isTerminalSignalingError(error)) {
          trace('WEBRTC_SIGNALING', 'heartbeat.failed', null, {
            epoch,
            errorCode: error?.code,
            httpStatus: error?.status,
            decision: 'preserve_open_data_channel',
            transportResult: 'retrying_signaling_only',
          });
          scheduleHeartbeatRetry(epoch);
          status('connected', { epoch, reason: 'signaling_failure_preserved' });
          return;
        }
        handleConnectError(error, 'heartbeat_failed');
      }
    }, interval);
  }

  function scheduleHeartbeatRetry(epoch) {
    clearHeartbeat();
    if (stopped || epoch !== connectionEpoch) return;
    heartbeatTimer = setTimer(async () => {
      heartbeatTimer = null;
      if (stopped || epoch !== connectionEpoch) return;
      try {
        const result = await client.join();
        if (stopped || epoch !== connectionEpoch) return;
        signalingHealth = 'healthy';
        recoveryTrace('SIGNALING_RECOVERED', null, { epoch, reason: 'heartbeat_retry_succeeded' });
        trace('WEBRTC_SIGNALING', 'heartbeat.recovered', null, {
          epoch,
          decision: 'open_data_channel_preserved',
          transportResult: 'recovered',
        });
        scheduleHeartbeat(result.ttlMs, epoch);
        if (hasOpenDataChannel()) status('connected', { epoch, reason: 'signaling_recovered' });
      } catch (error) {
        if (stopped || epoch !== connectionEpoch) return;
        signalingHealth = 'recovering';
        recoveryTrace('SIGNALING_FAILURE', null, {
          epoch, reason: error?.code || 'heartbeat_retry_failed', httpStatus: error?.status,
        });
        if (hasOpenDataChannel() && !isTerminalSignalingError(error)) {
          trace('WEBRTC_SIGNALING', 'heartbeat.retry_failed', null, {
            epoch,
            errorCode: error?.code,
            httpStatus: error?.status,
            decision: 'preserve_open_data_channel',
            transportResult: 'retrying_signaling_only',
          });
          scheduleHeartbeatRetry(epoch);
          return;
        }
        handleConnectError(error, 'heartbeat_failed');
      }
    }, HEARTBEAT_RETRY_INTERVAL_MS);
  }

  function hasOpenDataChannel() {
    if (role === 'device') {
      return [...devicePeers.values()].some(isTransportHealthy);
    }
    return isTransportHealthy(active);
  }

  function isTerminalSignalingError(error) {
    return ['meeting_stopped', 'meeting_revoked', 'share_unauthorized'].includes(error?.code);
  }

  async function connect({ reconnecting = false } = {}) {
    cleanupAllPeers();
    clearDevicePoll();
    clearHeartbeat();
    joined = false;
    devicePollAfter = 0;
    devicePollFailures = 0;
    const epoch = ++connectionEpoch;
    signalingHealth = 'connecting';
    status(reconnecting ? 'reconnecting' : 'connecting', { epoch, attempt: retryAttempt });
    recoveryTrace(role === 'viewer' ? 'VIEWER_JOIN' : 'SIGNALING_JOIN', null, {
      epoch, reason: reconnecting ? 'recovery' : 'initial_connect',
    });
    trace('WEBRTC_SIGNALING', 'join.request', null, { epoch, decision: reconnecting ? 'reconnect' : 'connect' });
    try {
      const joinResult = await client.join();
      if (stopped || epoch !== connectionEpoch) return;
      joined = true;
      signalingHealth = 'healthy';
      iceServers = joinResult.iceServers || [];
      trace('WEBRTC_SIGNALING', 'join.success', null, { epoch, transportResult: 'joined' });
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
        livenessTimer: null,
        pendingPingId: null,
        lastDataChannelMessageAt: null,
        lastCueReceivedAt: null,
        lastPingAt: null,
        lastPongAt: null,
      };
      active = context;
      recoveryTrace('PEER_CREATED', context, { reason: reconnecting ? 'recovery' : 'initial_connect' });
      wirePeer(context);
      await client.signal('viewer-ready', {}, { negotiationId: context.negotiationId });
      if (!isCurrent(context)) return;
      trace('WEBRTC_SIGNALING', 'viewer-ready.sent', context, { transportResult: 'accepted' });
      status('waiting', { epoch, negotiationId: context.negotiationId });
      context.negotiationTimer = setTimer(() => {
        context.negotiationTimer = null;
        if (isCurrent(context) && !context.connected) scheduleReconnect('negotiation_timeout');
      }, NEGOTIATION_TIMEOUT_MS);
      schedulePoll(context);
    } catch (error) {
      if (stopped || epoch !== connectionEpoch) return;
      signalingHealth = 'recovering';
      recoveryTrace('SIGNALING_FAILURE', null, {
        epoch, reason: error?.code || error?.message || 'connect_failed', httpStatus: error?.status,
      });
      trace('WEBRTC_SIGNALING', 'join.failed', null, {
        epoch, reason: error?.code || error?.message || 'connect_failed', transportResult: 'failed',
      });
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
      trace('WEBRTC_PEER_STATE', 'connectionstatechange', context);
      recoveryTrace('PEER_CONNECTION_STATE', context, { reason: context.pc.connectionState });
      if (context.pc.connectionState === 'connected') {
        const recoveredFromDisconnect = Boolean(context.disconnectTimer);
        clearContextTimer(context, 'disconnectTimer');
        clearContextTimer(context, 'iceRestartTimer');
        if (recoveredFromDisconnect) recoveryTrace('DISCONNECT_RECOVERED', context, { reason: 'peer_connected' });
        if (context.channel?.readyState === 'open') markConnected(context);
      } else if (context.pc.connectionState === 'disconnected') {
        context.connected = false;
        recoveryTrace('TRANSPORT_DISCONNECTED', context, { reason: 'connection_state_disconnected' });
        scheduleDisconnectedRecovery(context);
        if (role === 'viewer') schedulePoll(context);
      } else if (context.pc.connectionState === 'failed') {
        recoveryTrace('RECOVERY_STARTED', context, { reason: 'peer_failed' });
        if (role === 'device') cleanupDevicePeer(context);
        else scheduleReconnect('peer_failed');
      } else if (context.pc.connectionState === 'closed') {
        recoveryTrace('RECOVERY_STARTED', context, { reason: 'peer_closed' });
        if (role === 'device') cleanupDevicePeer(context);
        else scheduleReconnect('peer_closed');
      }
    };
    context.pc.oniceconnectionstatechange = () => {
      if (!isCurrent(context)) return;
      trace('WEBRTC_PEER_STATE', 'iceconnectionstatechange', context);
      recoveryTrace('ICE_CONNECTION_STATE', context, { reason: context.pc.iceConnectionState });
      if (context.pc.iceConnectionState === 'disconnected') {
        context.connected = false;
        recoveryTrace('TRANSPORT_DISCONNECTED', context, { reason: 'ice_state_disconnected' });
        scheduleDisconnectedRecovery(context);
      } else if (context.pc.iceConnectionState === 'failed' || context.pc.iceConnectionState === 'closed') {
        recoveryTrace('RECOVERY_STARTED', context, { reason: `ice_${context.pc.iceConnectionState}` });
        if (role === 'device') cleanupDevicePeer(context);
        else scheduleReconnect(`ice_${context.pc.iceConnectionState}`);
      }
    };
    context.pc.onsignalingstatechange = () => {
      if (isCurrent(context)) trace('WEBRTC_PEER_STATE', 'signalingstatechange', context);
    };
    context.pc.ondatachannel = ({ channel }) => wireChannel(context, channel);
  }

  function markConnected(context) {
    if (!isCurrent(context) || !isTransportHealthy(context)) return;
    context.connected = true;
    clearContextTimer(context, 'negotiationTimer');
    clearContextTimer(context, 'disconnectTimer');
    clearContextTimer(context, 'iceRestartTimer');
    clearReconnect();
    retryAttempt = 0;
    status(hadOutage ? 'restored' : 'connected', { epoch: context.epoch, recovered: hadOutage });
    recoveryTrace('RECOVERY_COMPLETED', context, { reason: hadOutage ? 'transport_restored' : 'transport_connected' });
    hadOutage = false;
  }

  function wireChannel(context, nextChannel) {
    if (!isCurrent(context)) return;
    context.channel = nextChannel;
    context.adapter = createSubtitleDataChannelAdapter(nextChannel, {
      onEnvelope: (envelope) => {
        if (!isCurrent(context)) return;
        context.lastDataChannelMessageAt = now();
        trace('WEBRTC_DATA_CHANNEL', 'message.received', context, {
          messageType: envelope.type,
          sourceId: envelope.sourceId,
          sequence: envelope.sequence ?? envelope.toSequence ?? null,
          cueId: envelope.cue?.cueId,
          revision: envelope.cue?.revision,
          segmentId: envelope.cue?.segmentId,
          sessionId: envelope.cue?.sessionId,
          receivedAt: Date.now(),
          transportResult: 'received',
        });
        if (envelope.type === SUBTITLE_ENVELOPE_TYPES.livenessPing) {
          context.adapter?.send(createLivenessEnvelope(SUBTITLE_ENVELOPE_TYPES.livenessPong, envelope.requestId));
          return;
        }
        if (envelope.type === SUBTITLE_ENVELOPE_TYPES.livenessPong) {
          if (envelope.requestId === context.pendingPingId) {
            context.pendingPingId = null;
            context.lastPongAt = now();
          }
          return;
        }
        if (envelope.type === SUBTITLE_ENVELOPE_TYPES.cueAppend
          || envelope.type === SUBTITLE_ENVELOPE_TYPES.cueUpdate) context.lastCueReceivedAt = now();
        if (role === 'device' && envelope.type === SUBTITLE_ENVELOPE_TYPES.replayRequest) {
          const replay = source.replay(envelope);
          context.adapter?.send(replay);
          recoveryTrace(replay.type === SUBTITLE_ENVELOPE_TYPES.snapshot ? 'SNAPSHOT_RECEIVED' : 'REPLAY_COMPLETED', context, {
            reason: 'device_response_sent', sequence: replay.sequence ?? replay.toSequence,
          });
          return;
        }
        if (role === 'viewer') {
          rememberViewerCursor(context, envelope);
          if (envelope.type === SUBTITLE_ENVELOPE_TYPES.snapshot) {
            recoveryTrace('SNAPSHOT_RECEIVED', context, { reason: 'recovery_payload', sequence: envelope.sequence });
          } else if (envelope.type === SUBTITLE_ENVELOPE_TYPES.replayResponse) {
            recoveryTrace('REPLAY_COMPLETED', context, { reason: 'recovery_payload', sequence: envelope.toSequence });
          }
          onEnvelope?.(envelope, Object.freeze({ transportGeneration: context.epoch, receivedAt: Date.now() }));
        }
      },
      onError: (error) => { if (isCurrent(context)) handleAsyncError(error); },
    });
    nextChannel.onopen = () => {
      if (!isCurrent(context)) return;
      const openedAt = now();
      context.lastDataChannelMessageAt = openedAt;
      context.lastPongAt = openedAt;
      trace('WEBRTC_DATA_CHANNEL', 'open', context, { transportResult: 'open' });
      recoveryTrace('DATA_CHANNEL_OPEN', context, { reason: 'channel_open' });
      scheduleLivenessCheck(context);
      markConnected(context);
      if (role === 'device') context.adapter.send(source.snapshot());
      else {
        const request = createReplayRequest({
          meetingId,
          requestId: createIdentifier('replay'),
          ...(lastSourceId ? { sourceId: lastSourceId } : {}),
          afterSequence: lastSourceSequence,
        });
        recoveryTrace('SNAPSHOT_REQUESTED', context, {
          reason: 'data_channel_open', sequence: lastSourceSequence,
        });
        context.adapter.send(request);
      }
    };
    nextChannel.onclose = () => {
      if (!isCurrent(context)) return;
      context.connected = false;
      trace('WEBRTC_DATA_CHANNEL', 'close', context, { transportResult: 'closed' });
      recoveryTrace('DATA_CHANNEL_CLOSE', context, { reason: 'channel_closed' });
      if (role === 'device') cleanupDevicePeer(context);
      else scheduleReconnect('data_channel_closed');
    };
    nextChannel.onerror = (error) => {
      if (!isCurrent(context)) return;
      context.connected = false;
      trace('WEBRTC_DATA_CHANNEL', 'error', context, {
        reason: error?.message || 'data_channel_error', transportResult: 'failed',
      });
      recoveryTrace('DATA_CHANNEL_ERROR', context, { reason: error?.message || 'data_channel_error' });
      handleAsyncError(error);
      if (role === 'device') cleanupDevicePeer(context);
      else scheduleReconnect('data_channel_error');
    };
  }

  function cleanupDevicePeer(context) {
    cleanupPeer(context);
    if (!stopped && currentPeerCounts().healthyPeerCount === 0) {
      hadOutage = true;
      status(devicePeers.size === 0 ? 'reconnecting' : 'connecting', {
        epoch: connectionEpoch, reason: 'device_peer_closed',
      });
    } else if (!stopped) {
      status('connected', { epoch: connectionEpoch, reason: 'viewer_peer_removed' });
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
      livenessTimer: null, pendingPingId: null,
      lastDataChannelMessageAt: null, lastCueReceivedAt: null, lastPingAt: null, lastPongAt: null,
      connected: false, pendingCandidates: [],
    };
    devicePeers.set(viewerId, context);
    recoveryTrace('PEER_CREATED', context, { reason: 'viewer_ready' });
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

  function createLivenessEnvelope(type, requestId) {
    return createEnvelope(type, { meetingId, requestId, sentAt: now() });
  }

  function scheduleLivenessCheck(context) {
    if (!isCurrent(context) || context.livenessTimer || context.channel?.readyState !== 'open') return;
    context.livenessTimer = setTimer(() => {
      context.livenessTimer = null;
      if (!isCurrent(context) || context.channel?.readyState !== 'open') return;
      if (documentRef?.visibilityState === 'hidden') {
        scheduleLivenessCheck(context);
        return;
      }
      const checkedAt = now();
      if (context.pendingPingId && checkedAt - context.lastPingAt >= DATA_CHANNEL_LIVENESS_TIMEOUT_MS) {
        context.connected = false;
        recoveryTrace('TRANSPORT_DISCONNECTED', context, {
          reason: 'data_channel_liveness_timeout',
        });
        if (role === 'device') cleanupDevicePeer(context);
        else scheduleReconnect('data_channel_liveness_timeout', { immediate: true });
        return;
      }
      if (!context.pendingPingId) {
        context.pendingPingId = createIdentifier('ping');
        context.lastPingAt = checkedAt;
        const sent = context.adapter?.send(createLivenessEnvelope(
          SUBTITLE_ENVELOPE_TYPES.livenessPing,
          context.pendingPingId,
        ));
        if (!sent) {
          context.connected = false;
          recoveryTrace('DATA_CHANNEL_ERROR', context, { reason: 'liveness_ping_send_failed' });
          if (role === 'device') cleanupDevicePeer(context);
          else scheduleReconnect('liveness_ping_send_failed', { immediate: true });
          return;
        }
      }
      scheduleLivenessCheck(context);
    }, DATA_CHANNEL_PING_INTERVAL_MS);
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
    recoveryTrace('DISCONNECT_GRACE_STARTED', context, {
      reason: 'transient_disconnected', graceMs: DISCONNECTED_GRACE_MS,
    });
    if (role === 'viewer' || ![...devicePeers.values()].some((peer) => peer !== context && peer.connected)) {
      status('reconnecting', { epoch: context.epoch, reason: 'peer_disconnected', graceMs: DISCONNECTED_GRACE_MS });
    }
    context.disconnectTimer = setTimer(async () => {
      context.disconnectTimer = null;
      if (!isCurrent(context) || context.pc.connectionState === 'connected') return;
      hadOutage = true;
      if (role !== 'device') {
        recoveryTrace('PEER_REBUILD_STARTED', context, { reason: 'disconnect_grace_expired' });
        scheduleReconnect('disconnected_timeout', { immediate: true });
        return;
      }
      try {
        recoveryTrace('ICE_RESTART_STARTED', context, { reason: 'disconnect_grace_expired' });
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
            recoveryTrace('ICE_RESTART_FAILED', context, { reason: 'ice_restart_timeout' });
            cleanupDevicePeer(context);
          }
        }, ICE_RESTART_TIMEOUT_MS);
      } catch (error) {
        if (!isCurrent(context)) return;
        recoveryTrace('ICE_RESTART_FAILED', context, { reason: error?.message || 'ice_restart_failed' });
        handleAsyncError(error);
        cleanupDevicePeer(context);
      }
    }, DISCONNECTED_GRACE_MS);
  }

  function handleConnectError(error, reason = 'signaling_failed') {
    const code = error?.code || 'webrtc_signaling_unavailable';
    signalingHealth = 'recovering';
    recoveryTrace('SIGNALING_FAILURE', null, {
      reason: code, httpStatus: error?.status, errorCode: code,
    });
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
    const recoveryContext = active;
    const lastTransportState = {
      connectionState: recoveryContext?.pc?.connectionState,
      iceConnectionState: recoveryContext?.pc?.iceConnectionState,
      dataChannelState: recoveryContext?.channel?.readyState,
    };
    hadOutage = true;
    connectionEpoch += 1;
    const scheduledEpoch = connectionEpoch;
    recoveryTrace('RECOVERY_STARTED', null, { epoch: scheduledEpoch, reason });
    recoveryTrace('PEER_REBUILD_STARTED', null, { epoch: scheduledEpoch, reason });
    clearHeartbeat();
    clearDevicePoll();
    cleanupAllPeers();
    joined = false;
    if (!isOnline()) {
      waitingForOnline = true;
      status('reconnecting', { reason: 'network_offline', attempt: retryAttempt });
      return;
    }
    if (retryAttempt >= MAX_RECOVERY_ATTEMPTS) {
      const recoveryDetails = {
        epoch: scheduledEpoch,
        generation: scheduledEpoch,
        viewerId: role === 'viewer' ? participantId : null,
        attemptCount: retryAttempt,
        reason: 'retry_exhausted',
        ...lastTransportState,
        timestamp: now(),
      };
      recoveryTrace('RECOVERY_EXHAUSTED', recoveryContext, recoveryDetails);
      status('recovery_failed', recoveryDetails);
      return;
    }
    const attempt = retryAttempt + 1;
    const delay = immediate ? 0 : jitter(RETRY_DELAYS_MS[retryAttempt], random);
    retryAttempt = attempt;
    status('reconnecting', { reason, attempt, delay });
    reconnectTimer = setTimer(() => {
      reconnectTimer = null;
      if (stopped || connectionEpoch !== scheduledEpoch) {
        recoveryTrace('STALE_GENERATION_IGNORED', null, {
          epoch: scheduledEpoch, reason: 'reconnect_timer', currentGeneration: connectionEpoch,
        });
        return;
      }
      void connect({ reconnecting: true });
    }, delay);
  }

  function terminateTransport() {
    stopped = true;
    connectionEpoch += 1;
    clearHeartbeat();
    clearDevicePoll();
    clearReconnect();
    cleanupAllPeers();
    joined = false;
    detachLifecycleListeners();
  }

  function rememberViewerCursor(context, envelope) {
    if (!isCurrent(context)) return;
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
    clearReconnect();
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
    const previous = cueVersions.get(cue.cueId);
    const messageType = previous ? SUBTITLE_ENVELOPE_TYPES.cueUpdate : SUBTITLE_ENVELOPE_TYPES.cueAppend;
    try {
      const serialized = JSON.stringify(cue);
      if (previous?.serialized === serialized) return false;
      recordLivePipelineTrace({
        stage: 'VIEWER_PUBLISH_STARTED',
        meetingId,
        sessionId: cue.sessionId,
        segmentId: cue.segmentId,
        cueId: cue.cueId,
        connectionEpoch,
        dataChannelState: [...devicePeers.values()].find((context) => context.channel?.readyState === 'open')?.channel?.readyState,
      });
      const revision = (previous?.revision || 0) + 1;
      const normalized = { ...cue, meetingId, revision: Math.max(Number(cue.revision) || 0, revision) };
      const envelope = previous ? source.update(normalized) : source.append(normalized);
      if (!envelope) return false;
      cueVersions.set(cue.cueId, { serialized, revision: normalized.revision });
      let sent = false;
      for (const context of devicePeers.values()) sent = Boolean(context.adapter?.send(envelope)) || sent;
      trace('WEBRTC_CUE_PUBLISH', messageType, null, {
        cueId: cue.cueId,
        sequence: envelope.sequence,
        revision: normalized.revision,
        segmentId: cue.segmentId,
        sessionId: cue.sessionId,
        sourceId: envelope.sourceId,
        decision: sent ? 'sent_live' : 'stored_for_snapshot',
        transportResult: sent ? 'sent' : 'no_open_channel',
      });
      recordLivePipelineTrace({
        stage: sent ? 'VIEWER_PUBLISH_SUCCEEDED' : 'VIEWER_PUBLISH_FAILED',
        meetingId,
        sessionId: cue.sessionId,
        segmentId: cue.segmentId,
        cueId: cue.cueId,
        connectionEpoch,
        transportResult: sent ? 'sent' : 'stored_for_snapshot',
        errorCode: sent ? null : 'no_open_data_channel',
      });
      return sent;
    } catch (error) {
      recordLivePipelineTrace({
        stage: 'VIEWER_PUBLISH_FAILED',
        meetingId,
        sessionId: cue.sessionId,
        segmentId: cue.segmentId,
        cueId: cue.cueId,
        connectionEpoch,
        transportResult: 'rejected',
        errorCode: error?.code,
      });
      recordEnvelopeRejection(cue, messageType, error);
      onError?.(error);
      return false;
    }
  }

  function recordEnvelopeRejection(cue, messageType, error) {
    const rawSourcePresent = hasText(cue?.rawSource);
    const sourcePresent = rawSourcePresent || hasText(cue?.sourceText);
    const translationPresent = hasText(cue?.rawTranslation) || hasText(cue?.translatedText);
    recordLivePipelineTrace({
      stage: 'DATA_CHANNEL_ENVELOPE_REJECTED',
      meetingId,
      recordingId: meetingId,
      cueId: cue?.cueId,
      messageType,
      sourcePresent,
      translationPresent,
      rawSourcePresent,
      refinedSourcePresent: hasText(cue?.refinedSource),
      sourceStatus: cue?.sourceStatus,
      translationStatus: cue?.translationStatus,
      sourceVersion: cue?.sourceVersion,
      translationVersion: cue?.translationVersion,
      audioTurnIdPresent: hasText(cue?.audioTurnId),
      reason: error?.message || 'subtitle_envelope_rejected',
      validatorCode: error?.code || 'unknown_validation_error',
      transportResult: 'rejected'
    });
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
      clearReconnect();
      attachLifecycleListeners();
      void connect({ reconnecting: true });
    },
    publishCue,
    async stop({ revoke = false } = {}) {
      stopped = true;
      connectionEpoch += 1;
      clearHeartbeat();
      clearDevicePoll();
      clearReconnect();
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

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
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
