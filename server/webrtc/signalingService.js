const DEFAULTS = Object.freeze({
  maxViewersPerMeeting: 4,
  maxMessageBytes: 64 * 1024,
  messageTtlMs: 30_000,
  relayPolicy: 'direct-first',
});

const SIGNAL_TYPES = new Set(['offer', 'answer', 'ice-candidate']);
const SHARE_ROLES = new Set(['host', 'recorder', 'viewer']);
const ICE_SCHEMES = new Set(['stun:', 'stuns:', 'turn:', 'turns:']);

export class SignalingServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SignalingServiceError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new SignalingServiceError(code, message);
}

function nowMs(clock) {
  const value = Number(clock());
  return Number.isFinite(value) ? value : Date.now();
}

function assertMeetingId(meetingId) {
  if (typeof meetingId !== 'string' || meetingId.length === 0) {
    fail('invalid_meeting', 'A meeting id is required.');
  }
}

function assertParticipantId(participantId) {
  if (typeof participantId !== 'string' || participantId.length === 0) {
    fail('invalid_participant', 'A participant id is required.');
  }
}

function hasSignalScope(scope) {
  if (scope === 'webrtc:signal') return true;
  if (Array.isArray(scope)) return scope.includes('webrtc:signal');
  if (scope && typeof scope === 'object') {
    return scope.webrtc === true || scope.signal === true || scope['webrtc:signal'] === true;
  }
  return false;
}

function normalizeIceServers(iceServers) {
  if (iceServers === undefined) return [];
  if (!Array.isArray(iceServers)) fail('invalid_ice_config', 'ICE servers must be an array.');
  return iceServers.map((server) => {
    if (!server || typeof server !== 'object' || !Array.isArray(server.urls)) {
      fail('invalid_ice_config', 'ICE server entries must have an urls array.');
    }
    if (server.urls.length === 0 || server.urls.some((url) => {
      try {
        return !ICE_SCHEMES.has(new URL(url).protocol);
      } catch {
        return true;
      }
    })) {
      fail('invalid_ice_config', 'ICE servers must use explicit STUN or TURN URLs.');
    }
    return Object.freeze({
      urls: Object.freeze([...server.urls]),
      ...(server.username === undefined ? {} : { username: server.username }),
      ...(server.credential === undefined ? {} : { credential: server.credential }),
    });
  });
}

export function classifyCandidate(candidate) {
  const type = typeof candidate === 'string'
    ? candidate.match(/(?:^|\s)typ\s+(host|srflx|relay)(?:\s|$)/u)?.[1]
    : candidate?.type;
  if (type === 'host' || type === 'srflx') return 'direct-candidate';
  if (type === 'relay') return 'turn-relay';
  return 'unknown-candidate';
}

export function createSignalingService(options = {}) {
  const config = { ...DEFAULTS, ...options };
  if (!Number.isInteger(config.maxViewersPerMeeting) || config.maxViewersPerMeeting < 1) {
    fail('invalid_limits', 'maxViewersPerMeeting must be a positive integer.');
  }
  if (!Number.isInteger(config.maxMessageBytes) || config.maxMessageBytes < 1
    || !Number.isInteger(config.messageTtlMs) || config.messageTtlMs < 1) {
    fail('invalid_limits', 'Message limits must be positive integers.');
  }
  if (config.relayPolicy !== 'direct-first') {
    fail('invalid_relay_policy', 'The PoC only supports direct-first relay policy.');
  }
  const clock = typeof config.clock === 'function' ? config.clock : Date.now;
  const iceServers = normalizeIceServers(config.iceServers);
  const meetings = new Map();

  function meetingState(meetingId) {
    assertMeetingId(meetingId);
    if (!meetings.has(meetingId)) meetings.set(meetingId, { participants: new Map(), messages: [] });
    return meetings.get(meetingId);
  }

  function authorizeShare({ meetingId, share, role } = {}) {
    assertMeetingId(meetingId);
    if (!share || typeof share !== 'object' || typeof share.id !== 'string'
      || share.meetingId !== meetingId || !SHARE_ROLES.has(share.role)
      || (role !== undefined && role !== share.role)
      || !hasSignalScope(share.scope)
      || share.revoked === true
      || (share.expiresAt !== undefined && (!Number.isFinite(share.expiresAt) || share.expiresAt <= nowMs(clock)))) {
      fail('share_unauthorized', 'Share is not authorized for this meeting and role.');
    }
    return Object.freeze({ id: share.id, meetingId, role: share.role });
  }

  function join({ meetingId, share, role } = {}) {
    const authorized = authorizeShare({ meetingId, share, role });
    const state = meetingState(meetingId);
    const existing = state.participants.get(authorized.id);
    if (!existing && authorized.role === 'viewer') {
      const viewerCount = [...state.participants.values()].filter((item) => item.role === 'viewer').length;
      if (viewerCount >= config.maxViewersPerMeeting) fail('viewer_cap_reached', 'Meeting viewer cap reached.');
    }
    state.participants.set(authorized.id, authorized);
    return authorized;
  }

  function send({ meetingId, participantId, type, payload } = {}) {
    assertMeetingId(meetingId);
    assertParticipantId(participantId);
    const state = meetingState(meetingId);
    if (!state.participants.has(participantId)) fail('participant_unauthorized', 'Participant is not joined.');
    if (!SIGNAL_TYPES.has(type)) fail('invalid_signal_type', 'Only offer, answer, and ice-candidate are supported.');
    let encoded;
    try { encoded = JSON.stringify(payload); } catch { fail('message_too_large', 'Signaling payload is not serializable.'); }
    const bytes = Buffer.byteLength(encoded ?? 'null', 'utf8');
    if (bytes > config.maxMessageBytes) fail('message_too_large', 'Signaling message exceeds the byte limit.');
    const sentAt = nowMs(clock);
    const message = Object.freeze({
      id: `${participantId}:${sentAt}:${state.messages.length}`,
      meetingId,
      participantId,
      type,
      payload,
      sentAt,
      expiresAt: sentAt + config.messageTtlMs,
    });
    state.messages.push(message);
    return message;
  }

  function receive({ meetingId, participantId, after = 0 } = {}) {
    assertMeetingId(meetingId);
    assertParticipantId(participantId);
    const state = meetingState(meetingId);
    if (!state.participants.has(participantId)) fail('participant_unauthorized', 'Participant is not joined.');
    const current = nowMs(clock);
    state.messages = state.messages.filter((message) => message.expiresAt > current);
    return state.messages.filter((message) => message.participantId !== participantId && message.sentAt > after);
  }

  return Object.freeze({
    authorizeShare,
    join,
    send,
    receive,
    getIceConfiguration() {
      return Object.freeze({ iceServers, relayPolicy: config.relayPolicy });
    },
  });
}
