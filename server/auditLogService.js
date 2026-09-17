const AUDIT_ACTIONS = new Set(['member_invited', 'member_removed', 'user_approved', 'user_enabled', 'user_disabled', 'asset_transfer', 'auth_login']);
const SAFE_KEYS = new Set(['actor_user_id', 'target_user_id', 'target_meeting_id', 'request_id', 'action', 'result', 'created_at']);
const SENSITIVE_KEYS = /token|secret|key|audio|transcript|cue|credential|password|authorization/i;

export function createAuditLogService({ repository, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const resolvedRepository = repository || (env.SUPABASE_URL && env.SUPABASE_SECRET_KEY ? {
    async append(entry) {
      const response = await fetchImpl(`${String(env.SUPABASE_URL).replace(/\/$/u, '')}/rest/v1/audit_logs`, {
        method: 'POST',
        headers: { apikey: env.SUPABASE_SECRET_KEY, Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(entry)
      });
      if (!response?.ok) throw auditError('audit_write_failed');
    }
  } : null);
  return Object.freeze({
    async record(entry = {}) {
      if (!AUDIT_ACTIONS.has(entry.action)) throw auditError('audit_action_invalid');
      if (!['success', 'failure'].includes(entry.result)) throw auditError('audit_result_invalid');
      const safe = {};
      for (const [key, value] of Object.entries(entry)) {
        if (SENSITIVE_KEYS.test(key)) continue;
        if (SAFE_KEYS.has(key)) safe[key] = value;
      }
      safe.created_at ||= new Date().toISOString();
      if (typeof resolvedRepository?.append === 'function') await resolvedRepository.append(safe);
      return safe;
    }
  });
}

function auditError(code) { const error = new Error(code); error.code = code; return error; }
