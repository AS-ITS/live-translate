import { randomUUID } from 'node:crypto';
import { currentRequestOwnerId } from '../../server/requestIdentity.js';
import { createSupabaseRestClient, eq } from './supabaseRestClient.js';

export function createSupabaseRecorderLeaseService({ env = process.env, fetchImpl = globalThis.fetch, clock = () => Date.now(), ttlMs = 10_000 } = {}) {
  const client = createSupabaseRestClient({ env, fetchImpl });
  if (!client) return null;
  const owner = () => currentRequestOwnerId() || env.SUPABASE_WORKER_USER_ID || failOwner();
  const query = (sessionId) => `?${eq('session_id', sessionId)}&${eq('owner_user_id', owner())}`;
  return Object.freeze({
    requiresRequestIdentity: true,
    async claim(sessionId) {
      const existing = await client.request('recorder_leases', { query: query(sessionId) });
      if (existing[0] && new Date(existing[0].expires_at).getTime() > clock()) {
        const error = new Error('Recorder lease is already active.'); error.code = 'recorder_already_active'; error.lease = dto(existing[0]); throw error;
      }
      const row = { id: existing[0]?.id || randomUUID(), owner_user_id: owner(), session_id: sessionId, lease_id: `lease-${randomUUID()}`, fence_token: (existing[0]?.fence_token || 0) + 1, expires_at: new Date(clock() + ttlMs).toISOString(), updated_at: new Date(clock()).toISOString() };
      const result = existing[0] ? await client.request('recorder_leases', { method: 'PATCH', query: query(sessionId), body: row }) : await client.request('recorder_leases', { method: 'POST', body: [row] });
      return dto(result[0] || row, sessionId);
    },
    async heartbeat(sessionId, leaseId, fenceToken) {
      const result = await client.request('recorder_leases', { method: 'PATCH', query: `${query(sessionId)}&${eq('lease_id', leaseId)}&${eq('fence_token', fenceToken)}`, body: { expires_at: new Date(clock() + ttlMs).toISOString(), updated_at: new Date(clock()).toISOString() } });
      if (!result[0]) throw invalidLease();
      return dto(result[0], sessionId);
    },
    async release(sessionId, leaseId, fenceToken) {
      const result = await client.request('recorder_leases', { method: 'DELETE', query: `${query(sessionId)}&${eq('lease_id', leaseId)}&${eq('fence_token', fenceToken)}` });
      return result.length > 0;
    },
    async current(sessionId) {
      const result = await client.request('recorder_leases', { query: query(sessionId) });
      return result[0] && new Date(result[0].expires_at).getTime() > clock() ? dto(result[0], sessionId) : null;
    }
  });
}

function dto(row, sessionId = row.session_id) { return { sessionId, leaseId: row.lease_id, fenceToken: row.fence_token, expiresAt: new Date(row.expires_at).getTime(), lastHeartbeatAt: row.updated_at ? new Date(row.updated_at).getTime() : null }; }
function invalidLease() { const error = new Error('Recorder lease is invalid or expired.'); error.code = 'recorder_lease_invalid'; error.status = 409; return error; }
function failOwner() { const error = new Error('Authenticated owner required.'); error.code = 'auth_required'; error.status = 401; throw error; }
