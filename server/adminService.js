import { createAuditLogService } from './auditLogService.js';

const PUBLIC_PROFILE_FIELDS = 'id,email,full_name,avatar_url,role,status,disabled_at,created_at,updated_at';

export function createAdminService({ env = process.env, fetchImpl = globalThis.fetch, auditLogService = createAuditLogService({ env, fetchImpl }) } = {}) {
  const base = String(env.SUPABASE_URL || '').replace(/\/$/u, '');
  const secret = env.SUPABASE_SECRET_KEY;
  async function request(path, { method = 'GET', body } = {}) {
    if (!base || !secret) throw accountError('cloud_capability_unavailable', 503);
    const response = await fetchImpl(`${base}${path}`, { method, headers: { apikey: secret, Authorization: `Bearer ${secret}`, Prefer: 'return=representation', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw accountError(response.status === 404 ? 'account_not_found' : 'supabase_request_failed', response.status);
    return response.status === 204 ? [] : response.json();
  }
  function assertAdmin(actor) { if (actor && (actor.role !== undefined || actor.status !== undefined) && (actor.role !== 'super_admin' || actor.status !== 'active')) throw accountError('auth_forbidden', 403); }
  async function audit(entry) { try { await auditLogService?.record(entry); } catch { /* Account actions remain safe when audit storage is unavailable. */ } }
  return Object.freeze({
    async listUsers(actor) { assertAdmin(actor); return request(`/rest/v1/profiles?select=${encodeURIComponent(PUBLIC_PROFILE_FIELDS)}&order=created_at.asc`); },
    async enableUser(actor, targetUserId, requestId) {
      assertAdmin(actor);
      try {
        const rows = await request(`/rest/v1/profiles?id=eq.${encodeURIComponent(targetUserId)}`, { method: 'PATCH', body: { status: 'active', disabled_at: null, updated_at: new Date().toISOString() } });
        await audit({ actor_user_id: actor.id, target_user_id: targetUserId, action: 'user_enabled', request_id: requestId, result: 'success' });
        return rows[0];
      } catch (error) { await audit({ actor_user_id: actor.id, target_user_id: targetUserId, action: 'user_enabled', request_id: requestId, result: 'failure' }); throw error; }
    },
    async disableUser(actor, targetUserId, transferToUserId, requestId) {
      assertAdmin(actor);
      if (actor.id === targetUserId) {
        await audit({ actor_user_id: actor.id, target_user_id: targetUserId, action: 'user_disabled', request_id: requestId, result: 'failure' });
        throw accountError('cannot_disable_self', 400);
      }
      if (!transferToUserId || transferToUserId === targetUserId) {
        await audit({ actor_user_id: actor.id, target_user_id: targetUserId, action: 'asset_transfer', request_id: requestId, result: 'failure' });
        throw accountError('transfer_target_required', 400);
      }
      try {
        const rows = await request('/rest/v1/rpc/disable_user_with_transfer', { method: 'POST', body: { target_user_id: targetUserId, transfer_to_user_id: transferToUserId } });
        await audit({ actor_user_id: actor.id, target_user_id: targetUserId, action: 'asset_transfer', request_id: requestId, result: 'success' });
        await audit({ actor_user_id: actor.id, target_user_id: targetUserId, action: 'user_disabled', request_id: requestId, result: 'success' });
        return Array.isArray(rows) ? rows[0] : rows;
      } catch (error) {
        await audit({ actor_user_id: actor.id, target_user_id: targetUserId, action: 'asset_transfer', request_id: requestId, result: 'failure' });
        await audit({ actor_user_id: actor.id, target_user_id: targetUserId, action: 'user_disabled', request_id: requestId, result: 'failure' });
        throw error;
      }
    },
  });
}

function accountError(code, status) { const error = new Error(code); error.code = code; error.status = status; return error; }
