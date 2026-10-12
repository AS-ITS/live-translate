import { createRedisRestAdapter, createWebRtcSignalingRoute, WebRtcSignalingRouteError } from '../../server/webrtc/signalingRoute.js';
import { createAccessControl } from '../../server/accessControl.js';
import { createProfileService } from '../../server/profileService.js';
import { createSupabaseMeetingShareService } from '../../src/infrastructure/supabaseMeetingShareService.js';

export const config = { api: { bodyParser: false }, maxDuration: 10 };

export function parseWebRtcIceServersJson(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return [];
  try {
    const value = JSON.parse(String(raw));
    if (!Array.isArray(value)) throw new TypeError('ICE configuration must be an array.');
    const allowedProtocols = new Set(['stun:', 'stuns:', 'turn:', 'turns:']);
    return value.map((server) => {
      if (!server || typeof server !== 'object' || Array.isArray(server)
        || !Array.isArray(server.urls) || server.urls.length === 0
        || server.urls.some((url) => {
          try { return typeof url !== 'string' || !allowedProtocols.has(new URL(url).protocol); } catch { return true; }
        })) {
        throw new TypeError('ICE server entries require STUN or TURN urls.');
      }
      if (server.username !== undefined && typeof server.username !== 'string') throw new TypeError('ICE username must be a string.');
      if (server.credential !== undefined && typeof server.credential !== 'string') throw new TypeError('ICE credential must be a string.');
      return {
        urls: [...server.urls],
        ...(server.username === undefined ? {} : { username: server.username }),
        ...(server.credential === undefined ? {} : { credential: server.credential }),
      };
    });
  } catch {
    throw new Error('WEBRTC_ICE_SERVERS_JSON must be a valid RTCIceServer array.');
  }
}

export function createVercelWebRtcSignalingHandler({ redis, resolveShareToken, authorizeDevice, ...options } = {}) {
  const route = createWebRtcSignalingRoute({ redis, resolveShareToken, authorizeDevice, ...options });
  return async function vercelWebRtcSignalingHandler(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
      if (parts.length !== 4 || parts[0] !== 'api' || parts[1] !== 'webrtc') {
        throw new WebRtcSignalingRouteError('not_found', 404, 'Route not found.');
      }
      const [, , meetingId, action] = parts;
      let payload;
      if (req.method === 'POST' && ['join', 'signal', 'stop', 'leave'].includes(action)) {
        payload = await readJsonBody(req, options.maxRequestBytes ?? 70 * 1024);
      }
      let result;
      if (req.method === 'POST' && action === 'join') result = await route.join({ meetingId, body: payload, request: req });
      else if (req.method === 'POST' && action === 'signal') result = await route.signal({ meetingId, body: payload });
      else if (req.method === 'GET' && action === 'signal') result = await route.receive({ meetingId, participantId: url.searchParams.get('participantId'), after: url.searchParams.get('after') });
      else if (req.method === 'POST' && action === 'stop') result = await route.stop({ meetingId, body: payload });
      else if (req.method === 'POST' && action === 'leave') result = await route.leave({ meetingId, body: payload });
      else if (['join', 'signal', 'stop', 'leave'].includes(action)) throw new WebRtcSignalingRouteError('method_not_allowed', 405, 'Method not allowed.');
      else throw new WebRtcSignalingRouteError('not_found', 404, 'Route not found.');
      sendJson(res, 200, result);
    } catch (error) {
      const routeError = error instanceof WebRtcSignalingRouteError
        ? error
        : new WebRtcSignalingRouteError('webrtc_signaling_unavailable', 503, 'WebRTC signaling is unavailable.');
      sendJson(res, routeError.status, { error: { code: routeError.code, message: routeError.message }, ...(routeError.code === 'meeting_revoked' ? { revoked: true } : {}) });
    }
  };
}

export function createDefaultWebRtcShareResolver({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  if (!String(env.SUPABASE_URL || '').trim() || !String(env.SUPABASE_SECRET_KEY || '').trim()) return undefined;
  const shareService = createSupabaseMeetingShareService({ env, fetchImpl });
  return async function resolveShareCredential(credential, { kind = 'token' } = {}) {
    const share = kind === 'code'
      ? await shareService.resolveCode(credential)
      : await shareService.resolveShare(credential);
    if (!share) return null;
    const meetingStatus = await resolveMeetingStatus(share.meetingId, { env, fetchImpl });
    return Object.freeze({
      ...share,
      scope: ['webrtc:signal'],
      revoked: false,
      stopped: ['completed', 'failed'].includes(meetingStatus),
    });
  };
}

export function createDefaultWebRtcDeviceAuthorizer({
  env = process.env,
  fetchImpl = globalThis.fetch,
  accessControl = createAccessControl({ env }),
  profileService = createProfileService({ env, fetchImpl }),
} = {}) {
  if (!accessControl?.isConfigured?.() || !String(env.SUPABASE_SECRET_KEY || '').trim()) return undefined;
  return async function authorizeDevice({ meetingId, request }) {
    let user;
    try {
      user = await accessControl.validateRequest(request);
    } catch (error) {
      const code = ['auth_required', 'auth_invalid', 'auth_forbidden'].includes(error?.code) ? error.code : 'auth_invalid';
      throw new WebRtcSignalingRouteError(code, Number(error?.status) || 401, 'Device authentication failed.');
    }
    let allowed = false;
    try {
      allowed = await profileService.canRecordMeeting(user, meetingId);
    } catch {
      throw new WebRtcSignalingRouteError('webrtc_signaling_unavailable', 503, 'Recording permission could not be verified.');
    }
    if (!allowed) throw new WebRtcSignalingRouteError('recorder_forbidden', 403, 'Recording permission is required.');
    return Object.freeze({ userId: user.id });
  };
}

async function resolveMeetingStatus(meetingId, { env, fetchImpl }) {
  const endpoint = `${String(env.SUPABASE_URL).replace(/\/$/u, '')}/rest/v1/meetings?id=eq.${encodeURIComponent(meetingId)}&select=status`;
  const response = await fetchImpl(endpoint, {
    headers: {
      apikey: env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
    },
  });
  if (!response?.ok) throw new Error('Meeting status resolver is unavailable.');
  const rows = await response.json();
  if (!Array.isArray(rows) || typeof rows[0]?.status !== 'string') throw new Error('Meeting status resolver is unavailable.');
  return rows[0].status;
}

async function readJsonBody(req, maxBytes) {
  if (req.body !== undefined) return typeof req.body === 'string' ? parseJson(req.body) : req.body;
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    const value = Buffer.from(chunk);
    size += value.length;
    if (size > maxBytes) throw new WebRtcSignalingRouteError('request_too_large', 413, 'Request exceeds the byte limit.');
    chunks.push(value);
  }
  return parseJson(Buffer.concat(chunks).toString('utf8'));
}

function parseJson(raw) {
  try { return JSON.parse(raw); } catch { throw new WebRtcSignalingRouteError('invalid_json', 400, 'Request body must be valid JSON.'); }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

const configuredRedis = createRedisRestAdapter({
  url: process.env.WEBRTC_SIGNALING_REDIS_URL,
  token: process.env.WEBRTC_SIGNALING_REDIS_TOKEN,
});
const configuredIceServers = parseWebRtcIceServersJson(process.env.WEBRTC_ICE_SERVERS_JSON);

// Resolver injection is deliberate: no browser-provided share object is trusted.
export default createVercelWebRtcSignalingHandler({
  redis: configuredRedis,
  resolveShareToken: createDefaultWebRtcShareResolver(),
  authorizeDevice: createDefaultWebRtcDeviceAuthorizer(),
  iceServers: configuredIceServers,
});
