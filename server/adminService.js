import { createAuditLogService } from './auditLogService.js';

const PUBLIC_PROFILE_FIELDS = 'id,email,full_name,avatar_url,role,status,disabled_at,created_at,updated_at';

export function createAdminService({ env = process.env, fetchImpl = globalThis.fetch, auditLogService = createAuditLogService({ env, fetchImpl }) } = {}) {
  const base = String(env.SUPABASE_URL || '').replace(/\/$/u, '');
  const secret = env.SUPABASE_SECRET_KEY;

  async function request(path, { method = 'GET', body } = {}) {
    if (!base || !secret) {
      const error = new Error('Admin service is unavailable.');
      error.code = 'cloud_capability_unavailable';
      error.status = 503;
      throw error;
    }
    const response = await fetchImpl(`${base}${path}`, {
      method,
      headers: { apikey: secret, Authorization: `Bearer ${secret}`, Prefer: 'return=representation', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const error = new Error('Admin operation failed.');
      error.code = response.status === 404 ? 'account_not_found' : 'supabase_request_failed';
      error.status = response.status;
      throw error;
    }
    return response.status === 204 ? [] : response.json();
  }

  return Object.freeze({
    async listUsers() {
      return request(`/rest/v1/profiles?select=${encodeURIComponent(PUBLIC_PROFILE_FIELDS)}&order=created_at.asc`);
    },
    async enableUser(actor, targetUserId, requestId) {
      const rows = await request(`/rest/v1/profiles?id=eq.${encodeURIComponent(targetUserId)}`, { method: 'PATCH', body: { status: 'active', disabled_at: null, updated_at: new Date().toISOString() } });
      await auditLogService?.record({ actor_user_id: actor.id, target_user_id: targetUserId, action: 'enable', request_id: requestId, result: 'success' });
      return rows[0];
    },
    async disableUser(actor, targetUserId, transferToUserId, requestId) {
      if (actor.id === targetUserId) {
        const error = new Error('Cannot disable yourself.'); error.code = 'cannot_disable_self'; error.status = 400; throw error;
      }
      if (!transferToUserId || transferToUserId === targetUserId) {
        const error = new Error('An active transfer target is required.'); error.code = 'transfer_target_required'; error.status = 400; throw error;
      }
      const rows = await request('/rest/v1/rpc/disable_user_with_transfer', { method: 'POST', body: { target_user_id: targetUserId, transfer_to_user_id: transferToUserId } });
      await auditLogService?.record({ actor_user_id: actor.id, target_user_id: targetUserId, action: 'asset_transfer', request_id: requestId, result: 'success' });
      await auditLogService?.record({ actor_user_id: actor.id, target_user_id: targetUserId, action: 'disable', request_id: requestId, result: 'success' });
      return Array.isArray(rows) ? rows[0] : rows;
    },
  });
}
