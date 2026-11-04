import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createDefaultWebRtcDeviceAuthorizer, createDefaultWebRtcShareResolver, createVercelWebRtcSignalingHandler, parseWebRtcIceServersJson } from '../../api/webrtc/[...path].js';
import { createRedisRestAdapter } from '../../server/webrtc/signalingRoute.js';
import { routeNodeRequest } from '../../server/index.js';

class FakeRedis {
  constructor(clock) {
    this.clock = clock;
    this.values = new Map();
    this.members = new Map();
    this.sorted = new Map();
  }

  read(key) {
    const entry = this.values.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.clock()) { this.values.delete(key); return null; }
    return entry.value;
  }

  async get(key) { return this.read(key); }
  async set(key, value, mode, ttl) { this.values.set(key, { value, expiresAt: this.clock() + (mode === 'PX' ? Number(ttl) : 60_000) }); return 'OK'; }
  async del(key) { this.values.delete(key); return 1; }
  async incr(key) { const value = Number(this.read(key) || 0) + 1; await this.set(key, String(value), 'PX', 60_000); return value; }
  async pexpire(key, ttl) { const value = this.read(key); if (value !== null) await this.set(key, value, 'PX', ttl); return 1; }
  async zadd(key, score, value) { const values = this.sorted.get(key) || []; values.push({ score: Number(score), value }); values.sort((a, b) => a.score - b.score); this.sorted.set(key, values); return 1; }
  async zremrangebyrank(key, start, stop) {
    const values = this.sorted.get(key) || [];
    const end = stop < 0 ? values.length + stop : stop;
    values.splice(start, Math.max(0, end - start + 1));
    return 1;
  }
  async zrangebyscore(key, min, max, limit, offset, count) {
    const upper = max === '+inf' ? Infinity : Number(max);
    return (this.sorted.get(key) || []).filter(({ score }) => score >= Number(min) && score <= upper).slice(Number(offset), Number(offset) + Number(count)).map(({ value }) => value);
  }
  async mget(keys) { return keys.map((key) => this.read(key)); }
  async eval(script, count, ...args) {
    assert.equal(script.includes('webrtc-route-join'), true);
    assert.equal(count, 4);
    const [revokedKey, participantKey, membersKey, cursorKey, participantPrefix, participantRaw, ttl, cap, participantId] = args;
    if (this.read(revokedKey)) return ['revoked'];
    const existing = this.read(participantKey);
    if (existing) {
      await this.set(participantKey, participantRaw, 'PX', ttl);
      const members = this.members.get(membersKey) || new Set();
      members.add(participantId);
      this.members.set(membersKey, members);
      await this.pexpire(cursorKey, ttl);
      return ['existing', participantRaw];
    }
    const members = this.members.get(membersKey) || new Set();
    for (const member of members) if (!this.read(`${participantPrefix}${member}`)) members.delete(member);
    if (members.size >= Number(cap)) return ['cap'];
    await this.set(participantKey, participantRaw, 'PX', ttl);
    members.add(participantId);
    this.members.set(membersKey, members);
    await this.pexpire(cursorKey, ttl);
    return ['joined', participantRaw];
  }
}

function resolver(token) {
  const shares = {
    host: { id: 'share-host', meetingId: 'meeting-1', role: 'host', scope: ['webrtc:signal'], expiresAt: 61_000 },
    viewer: { id: 'share-viewer', meetingId: 'meeting-1', role: 'viewer', scope: ['webrtc:signal'], expiresAt: 61_000 },
    recorder: { id: 'share-recorder', meetingId: 'meeting-1', role: 'recorder', scope: ['webrtc:signal'], expiresAt: 61_000 },
    denied: { id: 'share-denied', meetingId: 'meeting-1', role: 'viewer', scope: ['meeting:read'], expiresAt: 61_000 },
  };
  return shares[token];
}

function request(handler, { method, url, body, headers = {} } = {}) {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  req.method = method;
  req.url = url;
  req.headers = headers;
  const res = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(raw) { this.raw = raw; } };
  return handler(req, res).then(() => ({ ...res, json: JSON.parse(res.raw) }));
}

function setup(overrides = {}) {
  let now = 1_000;
  const clock = () => now;
  const redis = new FakeRedis(clock);
  const options = { redis, resolveShareToken: resolver, clock, participantTtlMs: 100, messageTtlMs: 20, revocationTtlMs: 100, maxParticipantsPerMeeting: 3, maxMessageBytes: 32, ...overrides };
  return { one: createVercelWebRtcSignalingHandler(options), two: createVercelWebRtcSignalingHandler(options), setNow(value) { now = value; }, redis };
}

test('Node API forwards WebRTC requests to the shared signaling handler', async () => {
  const ctx = setup();
  const nodeHandler = (req, res) => routeNodeRequest(req, res, {
    webRtcHandler: ctx.one,
    applicationHandler: () => { throw new Error('WebRTC request reached the application handler.'); },
  });
  const joined = await request(nodeHandler, {
    method: 'POST', url: '/api/webrtc/meeting-1/join',
    body: { participantId: 'host-1', role: 'host', shareToken: 'host' },
  });
  assert.equal(joined.status, 200);
  const denied = await request(nodeHandler, {
    method: 'POST', url: '/api/webrtc/meeting-1/join',
    body: { participantId: 'viewer-1', role: 'viewer', shareToken: 'denied' },
  });
  assert.equal(denied.status, 403);
});

test('two Vercel handler instances share Redis-backed join, signal, and polling state', async () => {
  const ctx = setup();
  const joined = await request(ctx.one, { method: 'POST', url: '/api/webrtc/meeting-1/join', body: { participantId: 'host-1', role: 'host', shareToken: 'host' } });
  assert.equal(joined.status, 200);
  assert.deepEqual(joined.json.participant, { id: 'host-1', role: 'host', shareId: 'share-host', expiresAt: 1_100 });
  assert.deepEqual({ ttlMs: joined.json.ttlMs, iceServers: joined.json.iceServers, relayPolicy: joined.json.relayPolicy }, { ttlMs: 100, iceServers: [], relayPolicy: 'direct-first' });
  await request(ctx.two, { method: 'POST', url: '/api/webrtc/meeting-1/join', body: { participantId: 'viewer-1', role: 'viewer', shareToken: 'viewer' } });
  const sent = await request(ctx.one, { method: 'POST', url: '/api/webrtc/meeting-1/signal', body: { participantId: 'host-1', type: 'offer', payload: { sdp: 'ok' } } });
  assert.equal(sent.json.accepted, true);
  const polled = await request(ctx.two, { method: 'GET', url: '/api/webrtc/meeting-1/signal?participantId=viewer-1&after=0' });
  assert.equal(polled.status, 200);
  assert.deepEqual(polled.json.messages.map((message) => message.type), ['offer']);
  assert.equal(polled.json.after, 1);
  assert.equal([...ctx.redis.values.keys()].some((key) => key.includes('subtitle')), false);
});

test('targeted signaling reaches only the joined Viewer for its negotiation', async () => {
  const ctx = setup({ maxParticipantsPerMeeting: 4, maxMessageBytes: 256 });
  for (const participantId of ['host-1', 'viewer-a', 'viewer-b']) {
    await request(ctx.one, { method: 'POST', url: '/api/webrtc/meeting-1/join', body: participantId === 'host-1'
      ? { participantId, role: 'host', shareToken: 'host' }
      : { participantId, role: 'viewer', shareToken: 'viewer' } });
  }
  await request(ctx.one, { method: 'POST', url: '/api/webrtc/meeting-1/signal', body: {
    participantId: 'host-1', type: 'offer', payload: { type: 'offer', sdp: 'private' },
    targetParticipantId: 'viewer-a', negotiationId: 'n-a'
  } });
  const first = await request(ctx.two, { method: 'GET', url: '/api/webrtc/meeting-1/signal?participantId=viewer-a&after=0' });
  const second = await request(ctx.two, { method: 'GET', url: '/api/webrtc/meeting-1/signal?participantId=viewer-b&after=0' });
  assert.deepEqual(first.json.messages.map((message) => message.negotiationId), ['n-a']);
  assert.deepEqual(second.json.messages, []);
});

test('join heartbeat renews participant identity and TTL after reauthorization', async () => {
  let now = 1_000;
  const redis = new FakeRedis(() => now);
  const handler = createVercelWebRtcSignalingHandler({
    redis,
    resolveShareToken: resolver,
    clock: () => now,
    participantTtlMs: 100,
  });

  const first = await request(handler, {
    method: 'POST',
    url: '/api/webrtc/meeting-1/join',
    body: { participantId: 'viewer-heartbeat', role: 'viewer', shareToken: 'viewer' },
  });
  assert.equal(first.json.participant.expiresAt, 1_100);

  now = 1_060;
  const heartbeat = await request(handler, {
    method: 'POST',
    url: '/api/webrtc/meeting-1/join',
    body: { participantId: 'viewer-heartbeat', role: 'viewer', shareToken: 'viewer' },
  });
  assert.equal(heartbeat.json.participant.expiresAt, 1_160);

  now = 1_120;
  const poll = await request(handler, {
    method: 'GET',
    url: '/api/webrtc/meeting-1/signal?participantId=viewer-heartbeat&after=0',
  });
  assert.equal(poll.status, 200);
});

test('join heartbeat preserves monotonic signaling cursor beyond message TTL', async () => {
  const ctx = setup({ maxMessageBytes: 256 });
  await request(ctx.one, { method: 'POST', url: '/api/webrtc/meeting-1/join', body: { participantId: 'host-1', role: 'host', shareToken: 'host' } });
  await request(ctx.one, { method: 'POST', url: '/api/webrtc/meeting-1/join', body: { participantId: 'viewer-1', role: 'viewer', shareToken: 'viewer' } });
  const first = await request(ctx.one, { method: 'POST', url: '/api/webrtc/meeting-1/signal', body: {
    participantId: 'viewer-1', type: 'viewer-ready', payload: {}, negotiationId: 'generation-1'
  } });
  assert.equal(first.json.sequence, 1);

  ctx.setNow(1_015);
  await request(ctx.one, { method: 'POST', url: '/api/webrtc/meeting-1/join', body: { participantId: 'host-1', role: 'host', shareToken: 'host' } });
  ctx.setNow(1_025);
  const recovered = await request(ctx.one, { method: 'POST', url: '/api/webrtc/meeting-1/signal', body: {
    participantId: 'viewer-1', type: 'viewer-ready', payload: {}, negotiationId: 'generation-2'
  } });
  assert.equal(recovered.json.sequence, 2, 'recovery message must stay above the Recorder polling cursor');

  const polled = await request(ctx.two, { method: 'GET', url: '/api/webrtc/meeting-1/signal?participantId=host-1&after=1' });
  assert.deepEqual(polled.json.messages.map((message) => message.negotiationId), ['generation-2']);
});

test('server-only ICE JSON accepts STUN/TURN entries and rejects unsafe configuration', () => {
  assert.deepEqual(parseWebRtcIceServersJson(undefined), []);
  assert.deepEqual(parseWebRtcIceServersJson(JSON.stringify([
    { urls: ['stun:stun.example.test:3478'] },
    { urls: ['turns:turn.example.test:5349'], username: 'short-lived', credential: 'server-secret' },
  ])), [
    { urls: ['stun:stun.example.test:3478'] },
    { urls: ['turns:turn.example.test:5349'], username: 'short-lived', credential: 'server-secret' },
  ]);
  assert.throws(() => parseWebRtcIceServersJson('{bad json'), /WEBRTC_ICE_SERVERS_JSON/u);
  assert.throws(() => parseWebRtcIceServersJson(JSON.stringify([{ urls: ['https://example.test'] }])), /WEBRTC_ICE_SERVERS_JSON/u);
});

test('route fails closed for missing dependencies and rejects invalid share, cap, size, and expired messages', async () => {
  const unavailable = createVercelWebRtcSignalingHandler();
  assert.equal((await request(unavailable, { method: 'POST', url: '/api/webrtc/meeting-1/join', body: { participantId: 'x', shareToken: 'host' } })).status, 503);
  let unavailableNow = 1_000;
  const redisOnly = createVercelWebRtcSignalingHandler({ redis: new FakeRedis(() => unavailableNow) });
  assert.equal((await request(redisOnly, { method: 'POST', url: '/api/webrtc/meeting-1/join', body: { participantId: 'x', role: 'host', shareToken: 'host' } })).status, 503);
  const ctx = setup({ maxParticipantsPerMeeting: 2 });
  assert.equal((await request(ctx.one, { method: 'POST', url: '/api/webrtc/meeting-1/join', body: { participantId: 'bad', role: 'viewer', shareToken: 'denied' } })).json.error.code, 'share_unauthorized');
  await request(ctx.one, { method: 'POST', url: '/api/webrtc/meeting-1/join', body: { participantId: 'host-1', role: 'host', shareToken: 'host' } });
  await request(ctx.one, { method: 'POST', url: '/api/webrtc/meeting-1/join', body: { participantId: 'viewer-1', role: 'viewer', shareToken: 'viewer' } });
  assert.equal((await request(ctx.one, { method: 'POST', url: '/api/webrtc/meeting-1/join', body: { participantId: 'recorder-1', role: 'recorder', shareToken: 'recorder' } })).json.error.code, 'participant_cap_reached');
  assert.equal((await request(ctx.one, { method: 'POST', url: '/api/webrtc/meeting-1/signal', body: { participantId: 'host-1', type: 'subtitle', payload: {} } })).json.error.code, 'invalid_signal_type');
  assert.equal((await request(ctx.one, { method: 'POST', url: '/api/webrtc/meeting-1/signal', body: { participantId: 'host-1', type: 'offer', payload: 'x'.repeat(33) } })).json.error.code, 'message_too_large');
  await request(ctx.one, { method: 'POST', url: '/api/webrtc/meeting-1/signal', body: { participantId: 'host-1', type: 'offer', payload: { sdp: 'ok' } } });
  ctx.setNow(1_021);
  const polled = await request(ctx.two, { method: 'GET', url: '/api/webrtc/meeting-1/signal?participantId=viewer-1&after=0' });
  assert.deepEqual(polled.json.messages, []);
});

test('host or recorder revocation propagates across instances and blocks future signaling', async () => {
  const ctx = setup();
  await request(ctx.one, { method: 'POST', url: '/api/webrtc/meeting-1/join', body: { participantId: 'host-1', role: 'host', shareToken: 'host' } });
  await request(ctx.two, { method: 'POST', url: '/api/webrtc/meeting-1/join', body: { participantId: 'viewer-1', role: 'viewer', shareToken: 'viewer' } });
  assert.equal((await request(ctx.one, { method: 'POST', url: '/api/webrtc/meeting-1/stop', body: { participantId: 'viewer-1' } })).json.error.code, 'revoke_forbidden');
  const stopped = await request(ctx.one, { method: 'POST', url: '/api/webrtc/meeting-1/stop', body: { participantId: 'host-1' } });
  assert.deepEqual(stopped.json.revoked, true);
  const polling = await request(ctx.two, { method: 'GET', url: '/api/webrtc/meeting-1/signal?participantId=viewer-1&after=0' });
  assert.equal(polling.status, 410);
  assert.equal(polling.json.revoked, true);
  const signaling = await request(ctx.two, { method: 'POST', url: '/api/webrtc/meeting-1/signal', body: { participantId: 'viewer-1', type: 'answer', payload: {} } });
  assert.equal(signaling.status, 410);
});

test('default resolver uses the existing share authorization service and fails closed without cloud config', async () => {
  assert.equal(createDefaultWebRtcShareResolver({ env: {} }), undefined);

  const requestedUrls = [];
  const resolver = createDefaultWebRtcShareResolver({
    env: { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SECRET_KEY: 'server-only' },
    fetchImpl: async (url) => {
      requestedUrls.push(url);
      if (url.includes('/rest/v1/meetings?')) {
        return { ok: true, status: 200, async json() { return [{ status: 'active' }]; } };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return [{
            id: 'share-1',
            meeting_id: 'meeting-1',
            role: 'viewer',
            resource_type: 'meeting',
            expires_at: null,
            revoked_at: null,
          }];
        },
      };
    },
  });

  const share = await resolver('opaque-share-token-value');
  assert.equal(share.id, 'share-1');
  assert.equal(share.meetingId, 'meeting-1');
  assert.equal(share.role, 'viewer');
  assert.deepEqual(share.scope, ['webrtc:signal']);
  assert.equal(share.revoked, false);
  assert.equal(share.expiresAt, null);
  assert.match(requestedUrls[0], /\/rest\/v1\/viewer_shares\?select=\*&token_hash=eq\./u);
  await resolver('SDR96VY9', { kind: 'code' });
  assert.equal(requestedUrls.some((url) => /short_code_hash=eq\./u.test(url)), true);
  assert.equal(requestedUrls.some((url) => /\/rest\/v1\/meetings\?id=eq\.meeting-1/u.test(url)), true);
});

test('resolver outcomes reject invalid, expired, revoked, and stopped shares', async () => {
  let outcome = 'valid';
  const route = createVercelWebRtcSignalingHandler({
    redis: new FakeRedis(() => 1_000),
    resolveShareToken: async () => {
      if (outcome === 'valid') return { id: 'share-1', meetingId: 'meeting-1', role: 'viewer', scope: ['webrtc:signal'], expiresAt: null };
      if (outcome === 'expired') return { id: 'share-1', meetingId: 'meeting-1', role: 'viewer', scope: ['webrtc:signal'], expiresAt: 999 };
      if (outcome === 'revoked') return { id: 'share-1', meetingId: 'meeting-1', role: 'viewer', scope: ['webrtc:signal'], expiresAt: 2_000, revoked: true };
      if (outcome === 'stopped') return { id: 'share-1', meetingId: 'meeting-1', role: 'viewer', scope: ['webrtc:signal'], expiresAt: 2_000, stopped: true };
      return null;
    },
    participantTtlMs: 100,
  });

  assert.equal((await request(route, { method: 'POST', url: '/api/webrtc/meeting-1/join', body: { participantId: 'viewer-1', role: 'viewer', shareToken: 'opaque' } })).status, 200);
  for (const nextOutcome of ['invalid', 'expired', 'revoked']) {
    outcome = nextOutcome;
    const response = await request(route, { method: 'POST', url: `/api/webrtc/meeting-1/join`, body: { participantId: `viewer-${nextOutcome}`, role: 'viewer', shareToken: 'opaque' } });
    assert.equal(response.status, 403);
  }
  outcome = 'stopped';
  const stopped = await request(route, { method: 'POST', url: '/api/webrtc/meeting-1/join', body: { participantId: 'viewer-stopped', role: 'viewer', shareToken: 'opaque' } });
  assert.equal(stopped.status, 410);
  assert.equal(stopped.json.error.code, 'meeting_stopped');
});

test('signaling REST adapter accepts only HTTPS Upstash REST URLs', () => {
  assert.equal(createRedisRestAdapter({ url: 'http://redis.example.test', token: 'server-only' }), null);
  assert.equal(createRedisRestAdapter({ url: 'rediss://redis.example.test', token: 'server-only' }), null);
  assert.ok(createRedisRestAdapter({ url: 'https://redis.example.test', token: 'server-only' }));
});

test('join resolves a Viewer share code through the code credential path', async () => {
  const calls = [];
  const route = createVercelWebRtcSignalingHandler({
    redis: new FakeRedis(() => 1_000),
    resolveShareToken: async (credential, metadata) => {
      calls.push({ credential, metadata });
      return { id: 'share-code', meetingId: 'meeting-1', role: 'viewer', scope: ['webrtc:signal'], expiresAt: null };
    },
  });
  const response = await request(route, {
    method: 'POST',
    url: '/api/webrtc/meeting-1/join',
    body: { participantId: 'viewer-code', role: 'viewer', shareCode: 'SDR96VY9' },
  });
  assert.equal(response.status, 200, JSON.stringify(response.json));
  assert.deepEqual(calls, [{ credential: 'SDR96VY9', metadata: { kind: 'code' } }]);
});

test('Device join uses authenticated canRecord authorization and Viewer credentials cannot become Device', async () => {
  const route = createVercelWebRtcSignalingHandler({
    redis: new FakeRedis(() => 1_000),
    resolveShareToken: resolver,
    authorizeDevice: async ({ meetingId, request }) => {
      assert.equal(meetingId, 'meeting-1');
      if (request.headers.authorization !== 'Bearer signed-user-token') return null;
      return { userId: 'recorder-user' };
    },
  });
  const device = await request(route, {
    method: 'POST',
    url: '/api/webrtc/meeting-1/join',
    headers: { authorization: 'Bearer signed-user-token' },
    body: { participantId: 'device-1', role: 'device' },
  });
  assert.equal(device.status, 200);
  assert.equal(device.json.participant.role, 'device');
  assert.equal(device.json.participant.userId, 'recorder-user');

  const escalation = await request(route, {
    method: 'POST',
    url: '/api/webrtc/meeting-1/join',
    body: { participantId: 'device-2', role: 'device', shareToken: 'viewer' },
  });
  assert.equal(escalation.status, 403);
});

test('default Device authorizer uses existing canRecord rule and preserves safe auth errors', async () => {
  let checkedUser = null;
  const authorizer = createDefaultWebRtcDeviceAuthorizer({
    env: { SUPABASE_SECRET_KEY: 'server-only' },
    accessControl: {
      isConfigured: () => true,
      validateRequest: async () => ({ id: 'member-1' }),
    },
    profileService: {
      canRecordMeeting: async (user, meetingId) => {
        checkedUser = { user, meetingId };
        return true;
      },
    },
  });
  assert.deepEqual(await authorizer({ meetingId: 'meeting-1', request: {} }), { userId: 'member-1' });
  assert.deepEqual(checkedUser, { user: { id: 'member-1' }, meetingId: 'meeting-1' });

  const denied = createDefaultWebRtcDeviceAuthorizer({
    env: { SUPABASE_SECRET_KEY: 'server-only' },
    accessControl: { isConfigured: () => true, validateRequest: async () => ({ id: 'member-2' }) },
    profileService: { canRecordMeeting: async () => false },
  });
  await assert.rejects(() => denied({ meetingId: 'meeting-1', request: {} }), (error) => error.code === 'recorder_forbidden');
});

test('Viewer cannot offer, stop, or use a meeting-mismatched share', async () => {
  const ctx = setup();
  await request(ctx.one, { method: 'POST', url: '/api/webrtc/meeting-1/join', body: { participantId: 'viewer-1', role: 'viewer', shareToken: 'viewer' } });
  assert.equal((await request(ctx.one, { method: 'POST', url: '/api/webrtc/meeting-1/signal', body: { participantId: 'viewer-1', type: 'offer', payload: {} } })).json.error.code, 'signal_forbidden');
  assert.equal((await request(ctx.one, { method: 'POST', url: '/api/webrtc/meeting-1/stop', body: { participantId: 'viewer-1' } })).json.error.code, 'revoke_forbidden');
  const mismatched = createVercelWebRtcSignalingHandler({
    redis: new FakeRedis(() => 1_000),
    resolveShareToken: async () => ({ id: 'share-other', meetingId: 'meeting-2', role: 'viewer', scope: ['webrtc:signal'], expiresAt: 2_000 }),
  });
  assert.equal((await request(mismatched, { method: 'POST', url: '/api/webrtc/meeting-1/join', body: { participantId: 'viewer-2', role: 'viewer', shareToken: 'opaque-token-value-1234' } })).json.error.code, 'share_unauthorized');
});
