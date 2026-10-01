import { classifyCandidate } from './signalingService.js';

const DEFAULTS = Object.freeze({
  namespace: 'webrtc:signal:v1',
  participantTtlMs: 60_000,
  messageTtlMs: 30_000,
  revocationTtlMs: 60_000,
  maxParticipantsPerMeeting: 6,
  maxMessageBytes: 64 * 1024,
  maxMessageBacklog: 200,
  maxPollMessages: 100,
  relayPolicy: 'direct-first',
  iceServers: [],
});

const SIGNAL_TYPES = new Set(['offer', 'answer', 'ice-candidate']);
const SHARE_ROLES = new Set(['host', 'recorder', 'viewer']);
const DEVICE_ROLES = new Set(['device', 'host', 'recorder']);
const ICE_SCHEMES = new Set(['stun:', 'stuns:', 'turn:', 'turns:']);

export class WebRtcSignalingRouteError extends Error {
  constructor(code, status, message) {
    super(message);
    this.name = 'WebRtcSignalingRouteError';
    this.code = code;
    this.status = status;
  }
}

function fail(code, status, message) {
  throw new WebRtcSignalingRouteError(code, status, message);
}

function nowMs(clock) {
  const value = Number(clock());
  return Number.isFinite(value) ? value : Date.now();
}

function validIdentifier(value) {
  return typeof value === 'string' && /^[A-Za-z0-9:_-]{1,128}$/u.test(value);
}

function assertIdentifier(value, code, label) {
  if (!validIdentifier(value)) fail(code, 400, `${label} is invalid.`);
  return value;
}

function hasSignalScope(scope) {
  if (scope === 'webrtc:signal') return true;
  if (Array.isArray(scope)) return scope.includes('webrtc:signal');
  return Boolean(scope && typeof scope === 'object'
    && (scope.webrtc === true || scope.signal === true || scope['webrtc:signal'] === true));
}

function normalizeIceServers(iceServers) {
  if (!Array.isArray(iceServers)) fail('invalid_ice_config', 500, 'ICE servers must be an array.');
  return iceServers.map((server) => {
    if (!server || typeof server !== 'object' || !Array.isArray(server.urls) || server.urls.length === 0) {
      fail('invalid_ice_config', 500, 'ICE server entries must have an urls array.');
    }
    if (server.urls.some((url) => {
      try { return !ICE_SCHEMES.has(new URL(url).protocol); } catch { return true; }
    })) fail('invalid_ice_config', 500, 'ICE servers must use explicit STUN or TURN URLs.');
    return Object.freeze({
      urls: Object.freeze([...server.urls]),
      ...(server.username === undefined ? {} : { username: server.username }),
      ...(server.credential === undefined ? {} : { credential: server.credential }),
    });
  });
}

function assertLimits(config) {
  for (const key of ['participantTtlMs', 'messageTtlMs', 'revocationTtlMs', 'maxMessageBytes', 'maxMessageBacklog', 'maxPollMessages']) {
    if (!Number.isInteger(config[key]) || config[key] < 1) fail('invalid_limits', 500, `${key} must be a positive integer.`);
  }
  if (!Number.isInteger(config.maxParticipantsPerMeeting) || config.maxParticipantsPerMeeting < 1) {
    fail('invalid_limits', 500, 'maxParticipantsPerMeeting must be a positive integer.');
  }
  if (config.relayPolicy !== 'direct-first') fail('invalid_relay_policy', 500, 'Only direct-first relay policy is supported.');
}

function parseRedisJson(value) {
  if (value === null || value === undefined) return null;
  try { return JSON.parse(value); } catch { fail('signaling_state_invalid', 503, 'Signaling state is unavailable.'); }
}

function serialize(value) {
  try { return JSON.stringify(value); } catch { fail('message_too_large', 413, 'Signaling payload is not serializable.'); }
}

function assertRedis(redis) {
  const methods = ['get', 'set', 'del', 'eval', 'incr', 'pexpire', 'zadd', 'zrangebyscore', 'zremrangebyrank', 'mget'];
  if (!redis || methods.some((method) => typeof redis[method] !== 'function')) {
    fail('webrtc_signaling_unavailable', 503, 'WebRTC signaling storage is not configured.');
  }
}

function keyFor(namespace, meetingId, suffix) {
  return `${namespace}:${meetingId}:${suffix}`;
}

const JOIN_SCRIPT = `-- webrtc-route-join
if redis.call('GET', KEYS[1]) then return {'revoked'} end
local current = redis.call('GET', KEYS[2])
if current then
  redis.call('PEXPIRE', KEYS[2], ARGV[3])
  return {'existing', current}
end
for _, member in ipairs(redis.call('SMEMBERS', KEYS[3])) do
  if not redis.call('GET', ARGV[1] .. member) then redis.call('SREM', KEYS[3], member) end
end
if redis.call('SCARD', KEYS[3]) >= tonumber(ARGV[4]) then return {'cap'} end
redis.call('SET', KEYS[2], ARGV[2], 'PX', ARGV[3])
redis.call('SADD', KEYS[3], ARGV[5])
redis.call('PEXPIRE', KEYS[3], ARGV[3])
return {'joined', ARGV[2]}`;

export function createRedisSignalingStore({ redis, namespace = DEFAULTS.namespace, clock = Date.now, ...overrides } = {}) {
  assertRedis(redis);
  const config = { ...DEFAULTS, ...overrides, namespace };
  assertLimits(config);
  const iceServers = normalizeIceServers(config.iceServers);

  function meetingKeys(meetingId) {
    const base = keyFor(config.namespace, meetingId, '');
    return {
      base,
      revoked: `${base}revoked`,
      members: `${base}members`,
      cursor: `${base}cursor`,
      messages: `${base}messages`,
      participant(participantId) { return `${base}participant:${participantId}`; },
      message(sequence) { return `${base}message:${sequence}`; },
    };
  }

  async function getRevocation(keys) {
    return parseRedisJson(await redis.get(keys.revoked));
  }

  async function getParticipant(meetingId, participantId) {
    const keys = meetingKeys(meetingId);
    if (await getRevocation(keys)) fail('meeting_revoked', 410, 'Meeting signaling has been revoked.');
    const participant = parseRedisJson(await redis.get(keys.participant(participantId)));
    if (!participant) fail('participant_unauthorized', 403, 'Participant is not joined.');
    return participant;
  }

  return Object.freeze({
    getIceConfiguration() {
      return Object.freeze({ iceServers, relayPolicy: config.relayPolicy });
    },

    async join({ meetingId, participantId, participant, ttlMs }) {
      const keys = meetingKeys(meetingId);
      const result = await redis.eval(
        JOIN_SCRIPT,
        3,
        keys.revoked,
        keys.participant(participantId),
        keys.members,
        `${keys.base}participant:`,
        serialize(participant),
        String(ttlMs),
        String(config.maxParticipantsPerMeeting),
        participantId,
      );
      const [status, rawParticipant] = Array.isArray(result) ? result : [];
      if (status === 'revoked') fail('meeting_revoked', 410, 'Meeting signaling has been revoked.');
      if (status === 'cap') fail('participant_cap_reached', 429, 'Meeting participant cap reached.');
      if (status !== 'joined' && status !== 'existing') fail('signaling_state_invalid', 503, 'Signaling state is unavailable.');
      return parseRedisJson(rawParticipant);
    },

    async append({ meetingId, participantId, type, payload }) {
      const participant = await getParticipant(meetingId, participantId);
      if (participant.role === 'viewer' && type === 'offer') {
        fail('signal_forbidden', 403, 'Viewer participants cannot send offers.');
      }
      if (DEVICE_ROLES.has(participant.role) && type === 'answer') {
        fail('signal_forbidden', 403, 'Device participants cannot send answers.');
      }
      const encodedPayload = serialize(payload);
      if (Buffer.byteLength(encodedPayload, 'utf8') > config.maxMessageBytes) {
        fail('message_too_large', 413, 'Signaling message exceeds the byte limit.');
      }
      const keys = meetingKeys(meetingId);
      const sequence = Number(await redis.incr(keys.cursor));
      if (!Number.isSafeInteger(sequence) || sequence < 1) fail('signaling_state_invalid', 503, 'Signaling state is unavailable.');
      const sentAt = nowMs(clock);
      const message = Object.freeze({
        id: `${participantId}:${sequence}`,
        sequence,
        participantId,
        type,
        payload,
        sentAt,
        expiresAt: sentAt + config.messageTtlMs,
        ...(type === 'ice-candidate' ? { candidateKind: classifyCandidate(payload?.candidate) } : {}),
      });
      const messageKey = keys.message(sequence);
      await redis.set(messageKey, serialize(message), 'PX', config.messageTtlMs);
      await redis.zadd(keys.messages, sequence, messageKey);
      await redis.zremrangebyrank(keys.messages, 0, -(config.maxMessageBacklog + 1));
      await redis.pexpire(keys.messages, config.messageTtlMs);
      await redis.pexpire(keys.cursor, config.messageTtlMs);
      return message;
    },

    async receive({ meetingId, participantId, after }) {
      await getParticipant(meetingId, participantId);
      const keys = meetingKeys(meetingId);
      const entries = await redis.zrangebyscore(keys.messages, after + 1, '+inf', 'LIMIT', 0, config.maxPollMessages);
      if (!Array.isArray(entries) || entries.length === 0) return Object.freeze({ messages: [], after });
      const stored = await redis.mget(entries);
      const current = nowMs(clock);
      const messages = stored.map(parseRedisJson).filter((message) => message && message.expiresAt > current);
      const cursor = messages.reduce((latest, message) => Math.max(latest, message.sequence), after);
      return Object.freeze({
        messages: messages.filter((message) => message.participantId !== participantId),
        after: cursor,
      });
    },

    async revoke({ meetingId, participantId }) {
      const participant = await getParticipant(meetingId, participantId);
      if (!DEVICE_ROLES.has(participant.role)) {
        fail('revoke_forbidden', 403, 'Only a recording Device can revoke meeting signaling.');
      }
      const keys = meetingKeys(meetingId);
      const revokedAt = nowMs(clock);
      await redis.set(keys.revoked, serialize({ revokedAt, participantId }), 'PX', config.revocationTtlMs);
      return Object.freeze({ revoked: true, revokedAt, ttlMs: config.revocationTtlMs });
    },

    async leave({ meetingId, participantId }) {
      const participant = await getParticipant(meetingId, participantId);
      const keys = meetingKeys(meetingId);
      await redis.del(keys.participant(participantId));
      if (typeof redis.srem === 'function') await redis.srem(keys.members, participantId);
      return Object.freeze({ left: true, participantId, role: participant.role });
    },
  });
}

function authorizeResolvedShare({ resolvedShare, meetingId, clock }) {
  if (resolvedShare?.stopped === true) {
    fail('meeting_stopped', 410, 'Meeting has stopped.');
  }
  if (!resolvedShare || typeof resolvedShare !== 'object'
    || typeof resolvedShare.id !== 'string'
    || resolvedShare.meetingId !== meetingId
    || !SHARE_ROLES.has(resolvedShare.role)
    || !hasSignalScope(resolvedShare.scope)
    || resolvedShare.revoked === true
    || (resolvedShare.expiresAt !== null
      && resolvedShare.expiresAt !== undefined
      && (!Number.isFinite(resolvedShare.expiresAt) || resolvedShare.expiresAt <= nowMs(clock)))) {
    fail('share_unauthorized', 403, 'Share is not authorized for this meeting signaling route.');
  }
  return resolvedShare;
}

function parseAfter(value) {
  if (value === null || value === '') return 0;
  const after = Number(value);
  if (!Number.isSafeInteger(after) || after < 0) fail('invalid_after', 400, 'after must be a non-negative integer.');
  return after;
}

function normalizeBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('invalid_body', 400, 'Request body must be a JSON object.');
  return body;
}

export function createWebRtcSignalingRoute({ redis, resolveShareToken, authorizeDevice, clock = Date.now, ...options } = {}) {
  const configured = Boolean(redis && (typeof resolveShareToken === 'function' || typeof authorizeDevice === 'function'));
  const store = configured ? createRedisSignalingStore({ redis, clock, ...options }) : null;

  async function assertConfigured() {
    if (!store) {
      fail('webrtc_signaling_unavailable', 503, 'WebRTC signaling dependencies are not configured.');
    }
  }

  return Object.freeze({
    getIceConfiguration() {
      return store?.getIceConfiguration() ?? Object.freeze({ iceServers: [], relayPolicy: 'direct-first' });
    },

    async join({ meetingId, body, request }) {
      await assertConfigured();
      const { participantId, role, shareToken, shareCode } = normalizeBody(body);
      assertIdentifier(meetingId, 'invalid_meeting', 'Meeting id');
      assertIdentifier(participantId, 'invalid_participant', 'Participant id');
      if (role === 'device') {
        if (typeof authorizeDevice !== 'function') {
          fail('webrtc_signaling_unavailable', 503, 'Device signaling authorization is not configured.');
        }
        const authorization = await authorizeDevice({ meetingId, request });
        if (!authorization || typeof authorization.userId !== 'string') {
          fail('recorder_forbidden', 403, 'Recording permission is required.');
        }
        const ttlMs = options.participantTtlMs ?? DEFAULTS.participantTtlMs;
        const participant = await store.join({
          meetingId,
          participantId,
          ttlMs,
          participant: { id: participantId, role: 'device', userId: authorization.userId, expiresAt: nowMs(clock) + ttlMs },
        });
        const ice = store.getIceConfiguration();
        return Object.freeze({ participant, ttlMs, iceServers: ice.iceServers, relayPolicy: ice.relayPolicy });
      }
      if (typeof resolveShareToken !== 'function') {
        fail('webrtc_signaling_unavailable', 503, 'Viewer share authorization is not configured.');
      }
      const hasShareToken = typeof shareToken === 'string' && shareToken.length > 0 && shareToken.length <= 4096;
      const hasShareCode = typeof shareCode === 'string' && shareCode.length > 0 && shareCode.length <= 128;
      if (!hasShareToken && !hasShareCode) {
        fail('share_unauthorized', 403, 'A share token or code is required.');
      }
      let resolvedShare;
      try {
        resolvedShare = await resolveShareToken(hasShareCode ? shareCode : shareToken, { kind: hasShareCode ? 'code' : 'token' });
      } catch { fail('share_unauthorized', 403, 'Share is not authorized for this meeting signaling route.'); }
      const share = authorizeResolvedShare({ resolvedShare, meetingId, clock });
      if (!SHARE_ROLES.has(role) || role !== share.role || (role === 'viewer' && share.role !== 'viewer')) {
        fail('share_unauthorized', 403, 'Share role is not authorized for this meeting signaling route.');
      }
    const shareRemainingMs = share.expiresAt === null || share.expiresAt === undefined
      ? (options.participantTtlMs ?? DEFAULTS.participantTtlMs)
      : share.expiresAt - nowMs(clock);
    const ttlMs = Math.min(options.participantTtlMs ?? DEFAULTS.participantTtlMs, shareRemainingMs);
      if (!Number.isInteger(ttlMs) || ttlMs < 1) fail('share_unauthorized', 403, 'Share is expired.');
      const participant = await store.join({
        meetingId,
        participantId,
        ttlMs,
        participant: { id: participantId, role: share.role, shareId: share.id, expiresAt: nowMs(clock) + ttlMs },
      });
      const ice = store.getIceConfiguration();
      return Object.freeze({ participant, ttlMs, iceServers: ice.iceServers, relayPolicy: ice.relayPolicy });
    },

    async signal({ meetingId, body }) {
      await assertConfigured();
      const { participantId, type, payload } = normalizeBody(body);
      assertIdentifier(meetingId, 'invalid_meeting', 'Meeting id');
      assertIdentifier(participantId, 'invalid_participant', 'Participant id');
      if (!SIGNAL_TYPES.has(type)) fail('invalid_signal_type', 400, 'Only offer, answer, and ice-candidate are supported.');
      if (payload === undefined) fail('invalid_signal_payload', 400, 'A signaling payload is required.');
      const message = await store.append({ meetingId, participantId, type, payload });
      return Object.freeze({ accepted: true, id: message.id, sequence: message.sequence, expiresAt: message.expiresAt });
    },

    async receive({ meetingId, participantId, after }) {
      await assertConfigured();
      assertIdentifier(meetingId, 'invalid_meeting', 'Meeting id');
      assertIdentifier(participantId, 'invalid_participant', 'Participant id');
      return store.receive({ meetingId, participantId, after: parseAfter(after) });
    },

    async stop({ meetingId, body }) {
      await assertConfigured();
      const { participantId } = normalizeBody(body);
      assertIdentifier(meetingId, 'invalid_meeting', 'Meeting id');
      assertIdentifier(participantId, 'invalid_participant', 'Participant id');
      return store.revoke({ meetingId, participantId });
    },

    async leave({ meetingId, body }) {
      await assertConfigured();
      const { participantId } = normalizeBody(body);
      assertIdentifier(meetingId, 'invalid_meeting', 'Meeting id');
      assertIdentifier(participantId, 'invalid_participant', 'Participant id');
      return store.leave({ meetingId, participantId });
    },
  });
}

export function createRedisRestAdapter({ url, token, fetchImpl = globalThis.fetch } = {}) {
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return null;
  }
  if (parsedUrl.protocol !== 'https:' || typeof token !== 'string' || token.length === 0 || typeof fetchImpl !== 'function') return null;
  const endpoint = url.replace(/\/$/u, '');
  async function command(...parts) {
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(parts),
      });
    } catch { fail('webrtc_signaling_unavailable', 503, 'WebRTC signaling storage is unavailable.'); }
    if (!response.ok) fail('webrtc_signaling_unavailable', 503, 'WebRTC signaling storage is unavailable.');
    const body = await response.json().catch(() => null);
    if (!body || Object.hasOwn(body, 'error')) fail('webrtc_signaling_unavailable', 503, 'WebRTC signaling storage is unavailable.');
    return body.result;
  }
  return Object.freeze({
    get: (key) => command('GET', key),
    set: (key, value, mode, ttl) => command('SET', key, value, mode, ttl),
    del: (key) => command('DEL', key),
    eval: (script, count, ...args) => command('EVAL', script, count, ...args),
    incr: (key) => command('INCR', key),
    pexpire: (key, ttl) => command('PEXPIRE', key, ttl),
    zadd: (key, score, value) => command('ZADD', key, score, value),
    zrangebyscore: (key, min, max, limit, offset, count) => command('ZRANGEBYSCORE', key, min, max, limit, offset, count),
    zremrangebyrank: (key, start, stop) => command('ZREMRANGEBYRANK', key, start, stop),
    mget: (keys) => command('MGET', ...keys),
    srem: (key, member) => command('SREM', key, member),
  });
}
