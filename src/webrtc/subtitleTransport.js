import { createReplayRequest, createSubtitleDataChannelAdapter, createSubtitleSource, SUBTITLE_ENVELOPE_TYPES } from './subtitleDataChannel.js';
import { createWebRtcSignalingClient } from './signalingClient.js';

const RETRY_DELAYS_MS = Object.freeze([1_000, 2_000, 5_000, 10_000, 10_000]);

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
  let pc = null;
  let channelAdapter = null;
  let channel = null;
  let pollTimer = null;
  let reconnectTimer = null;
  let generation = 0;
  let pollAfter = 0;
  let retryAttempt = 0;
  let stopped = false;
  let connected = false;
  let pendingCandidates = [];

  initialCues.forEach(publishCue);

  function status(value, details = {}) {
    onStatus?.(Object.freeze({ value, ...details }));
  }

  function cleanupPeer() {
    if (pollTimer) clearTimer(pollTimer);
    pollTimer = null;
    pendingCandidates = [];
    connected = false;
    channelAdapter?.close();
    channelAdapter = null;
    channel = null;
    pc?.close?.();
    pc = null;
  }

  async function connect({ reconnecting = false } = {}) {
    const currentGeneration = ++generation;
    cleanupPeer();
    pollAfter = 0;
    status(reconnecting ? 'reconnecting' : 'connecting');
    try {
      const joined = await client.join();
      if (stopped || currentGeneration !== generation) return;
      pc = new RTCPeerConnectionImpl({ iceServers: joined.iceServers || [] });
      pc.onicecandidate = ({ candidate }) => {
        if (candidate && !stopped && currentGeneration === generation) {
          void client.signal('ice-candidate', candidate).catch(handleAsyncError);
        }
      };
      pc.onconnectionstatechange = () => {
        if (stopped || currentGeneration !== generation) return;
        if (pc.connectionState === 'connected') {
          connected = true;
          retryAttempt = 0;
          status('connected');
        } else if (['failed', 'disconnected'].includes(pc.connectionState)) {
          scheduleReconnect();
        }
      };
      pc.ondatachannel = ({ channel: incoming }) => wireChannel(incoming, currentGeneration);
      if (role === 'device') {
        wireChannel(pc.createDataChannel('subtitles'), currentGeneration);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await client.signal('offer', pc.localDescription);
      } else {
        status('waiting');
      }
      schedulePoll(currentGeneration);
    } catch (error) {
      if (stopped || currentGeneration !== generation) return;
      handleConnectError(error);
    }
  }

  function wireChannel(nextChannel, currentGeneration) {
    channel = nextChannel;
    channelAdapter = createSubtitleDataChannelAdapter(channel, {
      onEnvelope: (envelope) => {
        if (role === 'device' && envelope.type === SUBTITLE_ENVELOPE_TYPES.replayRequest) {
          channelAdapter?.send(source.replay(envelope));
          return;
        }
        if (role === 'viewer') onEnvelope?.(envelope);
      },
      onError: handleAsyncError,
    });
    channel.onopen = () => {
      if (stopped || currentGeneration !== generation) return;
      connected = true;
      retryAttempt = 0;
      status('connected');
      if (role === 'device') channelAdapter.send(source.snapshot());
      else channelAdapter.send(createReplayRequest({ meetingId, requestId: crypto.randomUUID(), afterSequence: 0 }));
    };
    channel.onclose = () => {
      if (!stopped && currentGeneration === generation) scheduleReconnect();
    };
  }

  function schedulePoll(currentGeneration) {
    if (stopped || currentGeneration !== generation) return;
    pollTimer = setTimer(async () => {
      pollTimer = null;
      try {
        const result = await client.poll(pollAfter);
        if (stopped || currentGeneration !== generation) return;
        for (const message of result.messages || []) {
          pollAfter = Math.max(pollAfter, Number(message.sequence) || 0);
          await handleSignal(message);
        }
        pollAfter = Math.max(pollAfter, Number(result.after) || 0);
      } catch (error) {
        if (!stopped && currentGeneration === generation && !connected) handleConnectError(error);
        return;
      }
      schedulePoll(currentGeneration);
    }, pollIntervalMs);
  }

  async function handleSignal(message) {
    if (!pc) return;
    if (message.type === 'offer' && role === 'viewer') {
      await pc.setRemoteDescription(message.payload);
      await flushCandidates();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await client.signal('answer', pc.localDescription);
      return;
    }
    if (message.type === 'answer' && role === 'device') {
      await pc.setRemoteDescription(message.payload);
      await flushCandidates();
      return;
    }
    if (message.type === 'ice-candidate') {
      if (pc.remoteDescription) await pc.addIceCandidate(message.payload);
      else pendingCandidates.push(message.payload);
    }
  }

  async function flushCandidates() {
    const candidates = pendingCandidates;
    pendingCandidates = [];
    for (const candidate of candidates) await pc.addIceCandidate(candidate);
  }

  function handleConnectError(error) {
    const code = error?.code || 'webrtc_signaling_unavailable';
    if (code === 'meeting_stopped' || code === 'meeting_revoked') {
      cleanupPeer();
      status('stopped', { code });
      onError?.(error);
      return;
    }
    if (code === 'share_unauthorized') {
      cleanupPeer();
      status('invalid', { code });
      onError?.(error);
      return;
    }
    onError?.(error);
    scheduleReconnect();
  }

  function handleAsyncError(error) {
    if (!stopped) onError?.(error);
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    if (retryAttempt >= RETRY_DELAYS_MS.length) {
      cleanupPeer();
      status('failed');
      return;
    }
    const delay = RETRY_DELAYS_MS[retryAttempt++];
    cleanupPeer();
    status('reconnecting');
    reconnectTimer = setTimer(() => {
      reconnectTimer = null;
      void connect({ reconnecting: true });
    }, delay);
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
    return envelope ? Boolean(channelAdapter?.send(envelope)) : false;
  }

  return Object.freeze({
    participantId,
    async getStats() {
      if (!pc || typeof pc.getStats !== 'function') return [];
      return candidatePairEvidence(await pc.getStats());
    },
    start() {
      stopped = false;
      retryAttempt = 0;
      void connect();
    },
    retry() {
      stopped = false;
      retryAttempt = 0;
      if (reconnectTimer) clearTimer(reconnectTimer);
      reconnectTimer = null;
      void connect({ reconnecting: true });
    },
    publishCue,
    async stop({ revoke = false } = {}) {
      stopped = true;
      generation += 1;
      if (reconnectTimer) clearTimer(reconnectTimer);
      reconnectTimer = null;
      if (revoke && role === 'device') {
        channelAdapter?.send({ protocol: 'subtitle-webrtc/v1', type: SUBTITLE_ENVELOPE_TYPES.meetingStopped, meetingId });
      }
      cleanupPeer();
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
