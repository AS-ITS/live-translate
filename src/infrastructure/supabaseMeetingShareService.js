import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { currentRequestOwnerId } from '../../server/requestIdentity.js';
import { eq } from './supabaseRestClient.js';
import { createSupabaseRequestClient, requireSupabaseRequestClient } from './supabaseRequestClient.js';

const SHORT_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function createSupabaseMeetingShareService({
  env = process.env,
  fetchImpl = globalThis.fetch,
  clock = () => Date.now()
} = {}) {
  const clientForRequest = createSupabaseRequestClient({ env, fetchImpl });
  const client = { request: (...args) => requireSupabaseRequestClient(clientForRequest).request(...args) };

  return Object.freeze({
    requiresRequestIdentity: true,

    async createMeetingShare(meetingId, options = {}) {
      return createMeetingShare(client, { ownerUserId: owner(), meetingId, options, clock });
    },

    async ensureMeetingShare(meetingId, options = {}) {
      const ownerUserId = owner();
      const role = options.role || 'viewer';
      const rows = await client.request('viewer_shares', {
        query: `?select=*&${eq('owner_user_id', ownerUserId)}&${eq('meeting_id', meetingId)}&${eq('role', role)}&revoked_at=is.null&order=created_at.desc`
      });
      const existing = rows.find((row) => !row.expires_at || Date.parse(row.expires_at) > clock());
      if (existing) return { ...shareDTO(existing), reused: true };
      return createMeetingShare(client, { ownerUserId, meetingId, options, clock });
    },

    async listMeetingShares(meetingId) {
      const rows = await client.request('viewer_shares', {
        query: `?select=*&${eq('owner_user_id', owner())}&${eq('meeting_id', meetingId)}&order=created_at.desc`
      });
      return rows.filter((row) => !row.revoked_at && (!row.expires_at || Date.parse(row.expires_at) > clock())).map(shareDTO);
    },

    async listShares(meetingId) {
      return this.listMeetingShares(meetingId);
    },

    async resolveShare(token) {
      if (typeof token !== 'string' || token.length < 20) return null;
      return resolve(client, { tokenHash: sha256(token), clock });
    },

    async resolveCode(code) {
      if (typeof code !== 'string' || !/^[A-HJ-NP-Z2-9]{8}$/iu.test(code)) return null;
      return resolve(client, { shortCodeHash: sha256(code.toUpperCase()), clock });
    },

    async revokeShare(meetingId, shareId) {
      const ownerUserId = owner();
      const rows = await client.request('viewer_shares', {
        method: 'PATCH',
        query: `?${eq('id', shareId)}&${eq('meeting_id', meetingId)}&${eq('owner_user_id', ownerUserId)}`,
        body: { revoked_at: new Date(clock()).toISOString() }
      });
      return Boolean(rows[0]);
    },

    async revokeMeetingShares(meetingId) {
      const ownerUserId = owner();
      const rows = await client.request('viewer_shares', {
        method: 'PATCH',
        query: `?${eq('meeting_id', meetingId)}&${eq('owner_user_id', ownerUserId)}`,
        body: { revoked_at: new Date(clock()).toISOString() }
      });
      return rows.length;
    }
  });
}

async function createMeetingShare(client, { ownerUserId, meetingId, options, clock }) {
  const role = options.role || 'viewer';
  if (!['viewer', 'recorder'].includes(role)) throw new RangeError('Share role must be viewer or recorder.');
  const expiresAt = options.expiresAt === null || options.expiresAt === undefined
    ? null
    : new Date(options.expiresAt).toISOString();
  if (expiresAt && Date.parse(expiresAt) <= clock()) throw new RangeError('Share expiry must be in the future.');
  const token = randomBytes(32).toString('base64url');
  const shortCode = createShortCode();
  const row = {
    id: randomUUID(),
    owner_user_id: ownerUserId,
    meeting_id: meetingId,
    token_hash: sha256(token),
    short_code: shortCode,
    short_code_hash: sha256(shortCode),
    role,
    expires_at: expiresAt,
    resource_type: 'meeting'
  };
  const rows = await client.request('viewer_shares', { method: 'POST', body: [row] });
  return { ...shareDTO(rows[0] || row), token, shortCode, created: true };
}

async function resolve(client, { tokenHash, shortCodeHash, clock }) {
  const filter = tokenHash ? eq('token_hash', tokenHash) : eq('short_code_hash', shortCodeHash);
  const rows = await client.request('viewer_shares', { query: `?select=*&${filter}` });
  const row = rows[0];
  if (!row || row.revoked_at || (row.expires_at && Date.parse(row.expires_at) <= clock())) return null;
  return { ...shareDTO(row), _ownerUserId: row.owner_user_id };
}

function shareDTO(row) {
  return {
    id: row.id,
    sessionId: row.session_id || row.meeting_id,
    meetingId: row.meeting_id,
    role: row.role || 'viewer',
    resourceType: row.resource_type || 'meeting',
    ...(row.short_code ? { shortCode: row.short_code } : {}),
    createdAt: Date.parse(row.created_at) || row.created_at,
    expiresAt: row.expires_at ? Date.parse(row.expires_at) : null
  };
}

function owner() {
  const userId = currentRequestOwnerId();
  if (!userId) {
    const error = new Error('Authenticated owner required.');
    error.code = 'auth_required';
    error.status = 401;
    throw error;
  }
  return userId;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function createShortCode() {
  const bytes = randomBytes(8);
  return Array.from(bytes, (byte) => SHORT_CODE_ALPHABET[byte % SHORT_CODE_ALPHABET.length]).join('');
}
