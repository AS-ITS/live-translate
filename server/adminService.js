import { createAuditLogService } from './auditLogService.js';

const PUBLIC_PROFILE_FIELDS = 'id,email,full_name,avatar_url,role,status,disabled_at,created_at,updated_at';

export function createAdminService({ env = process.env, fetchImpl = globalThis.fetch, auditLogService = createAuditLogService({ env, fetchImpl }), observability } = {}) {
  const base = String(env.SUPABASE_URL || '').replace(/\/$/u, '');
  const secret = env.SUPABASE_SECRET_KEY;
  async function requestResponse(path, { method = 'GET', body, headers = {} } = {}) {
    if (!base || !secret) throw accountError('cloud_capability_unavailable', 503);
    const response = await fetchImpl(`${base}${path}`, { method, headers: { apikey: secret, Authorization: `Bearer ${secret}`, Prefer: 'return=representation', ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw accountError(response.status === 404 ? 'account_not_found' : 'supabase_request_failed', response.status);
    return response;
  }
  async function request(path, options = {}) {
    const response = await requestResponse(path, options);
    return response.status === 204 ? [] : response.json();
  }
  async function requestCount(path) {
    const response = await requestResponse(path, { headers: { Prefer: 'count=exact', Range: '0-0' } });
    const total = Number((response.headers.get('content-range') || '').split('/').at(-1));
    return Number.isFinite(total) ? total : 0;
  }
  function assertAdmin(actor) { if (!actor?.id || actor.role !== 'super_admin' || actor.status !== 'active') throw accountError('auth_forbidden', 403); }
  async function audit(entry) {
    try {
      await auditLogService?.record(entry);
    } catch {
      try {
        observability?.log?.({ event: 'audit_write_failed', action: entry.action, result: entry.result, requestId: entry.request_id });
      } catch {
        // Audit failure must never replace the account action's safe error.
      }
    }
  }
  return Object.freeze({
    async listAuditLogs(actor, options = {}) {
      assertAdmin(actor);
      const page = Number(options.page ?? 1);
      const pageSize = Number(options.pageSize ?? 25);
      const action = options.action ?? 'all';
      const result = options.result ?? 'all';
      const query = String(options.query ?? '').trim();
      const actions = ['member_invited', 'member_removed', 'user_enabled', 'user_disabled', 'asset_transfer'];
      if (!Number.isInteger(page) || page < 1 || ![25, 50, 100].includes(pageSize) || (action !== 'all' && !actions.includes(action)) || !['all', 'success', 'failure'].includes(result) || query.length > 100) throw accountError('invalid_request', 400);
      const filters = [];
      if (action !== 'all') filters.push(`action=eq.${encodeURIComponent(action)}`);
      if (result !== 'all') filters.push(`result=eq.${encodeURIComponent(result)}`);
      if (query) {
        const value = encodeURIComponent(query);
        filters.push(`or=(actor_user_id.ilike.*${value}*,target_user_id.ilike.*${value}*,target_meeting_id.ilike.*${value}*,request_id.ilike.*${value}*)`);
      }
      const from = (page - 1) * pageSize;
      const path = `/rest/v1/audit_logs?select=actor_user_id,target_user_id,target_meeting_id,request_id,action,result,created_at&order=created_at.desc${filters.length ? `&${filters.join('&')}` : ''}`;
      const response = await requestResponse(path, { headers: { Prefer: 'count=exact,return=representation', Range: `${from}-${from + pageSize - 1}` } });
      const rows = await response.json();
      const logs = rows.map((row) => ({
        actor_user_id: row.actor_user_id || null,
        target_user_id: row.target_user_id || null,
        target_meeting_id: row.target_meeting_id || null,
        request_id: row.request_id || null,
        action: row.action,
        result: row.result,
        created_at: row.created_at
      }));
      const total = Number((response.headers.get('content-range') || '').split('/').at(-1));
      const safeTotal = Number.isFinite(total) ? total : 0;
      return { logs, pagination: { page, pageSize, total: safeTotal, totalPages: Math.ceil(safeTotal / pageSize) } };
    },
    async listUsers(actor, options = {}) {
      assertAdmin(actor);
      const page = Number(options.page ?? 1);
      const pageSize = Number(options.pageSize ?? 12);
      const status = options.status ?? 'all';
      const query = String(options.query ?? '').trim();
      if (!Number.isInteger(page) || page < 1 || ![12, 24, 48].includes(pageSize) || !['all', 'active', 'disabled'].includes(status) || query.length > 100) throw accountError('invalid_request', 400);
      const filters = [];
      if (status !== 'all') filters.push(`status=eq.${status}`);
      if (query) {
        const encodedQuery = encodeURIComponent(query);
        filters.push(`or=(email.ilike.*${encodedQuery}*,role.ilike.*${encodedQuery}*)`);
      }
      const from = (page - 1) * pageSize;
      const listResponse = await requestResponse(`/rest/v1/profiles?select=${encodeURIComponent(PUBLIC_PROFILE_FIELDS)}&order=created_at.asc${filters.length ? `&${filters.join('&')}` : ''}`, { headers: { Prefer: 'count=exact,return=representation', Range: `${from}-${from + pageSize - 1}` } });
      const users = await listResponse.json();
      const total = Number((listResponse.headers.get('content-range') || '').split('/').at(-1));
      const [all, active, disabled, transferTargets] = await Promise.all([
        requestCount('/rest/v1/profiles?select=id'),
        requestCount('/rest/v1/profiles?select=id&status=eq.active'),
        requestCount('/rest/v1/profiles?select=id&status=eq.disabled'),
        request('/rest/v1/profiles?select=id,email&status=eq.active&order=email.asc')
      ]);
      const safeTotal = Number.isFinite(total) ? total : 0;
      return { users, transferTargets, counts: { all, active, disabled }, pagination: { page, pageSize, total: safeTotal, totalPages: Math.ceil(safeTotal / pageSize) } };
    },
    async enableUser(actor, targetUserId, requestId) {
      assertAdmin(actor);
      try {
        const rows = await request(`/rest/v1/profiles?id=eq.${encodeURIComponent(targetUserId)}`, { method: 'PATCH', body: { status: 'active', disabled_at: null, updated_at: new Date().toISOString() } });
        if (!rows[0]) throw accountError('account_not_found', 404);
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
        const targets = await request(`/rest/v1/profiles?id=in.(${encodeURIComponent(targetUserId)},${encodeURIComponent(transferToUserId)})&select=id,status`);
        if (!targets.some((item) => item.id === targetUserId)) throw accountError('account_not_found', 404);
        if (!targets.some((item) => item.id === transferToUserId && item.status === 'active')) throw accountError('transfer_target_invalid', 400);
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
