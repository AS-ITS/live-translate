const SENSITIVE_KEYS = /token|secret|key|audio|transcript|credential/i;

export function createAuditLogService({ repository, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const resolvedRepository = repository || (env.SUPABASE_URL && env.SUPABASE_SECRET_KEY ? {
    async append(entry) {
      await fetchImpl(`${String(env.SUPABASE_URL).replace(/\/$/u, '')}/rest/v1/audit_logs`, {
        method: 'POST',
        headers: { apikey: env.SUPABASE_SECRET_KEY, Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(entry)
      });
    }
  } : null);
  return Object.freeze({
    async record(entry = {}) {
      const safe = {};
      for (const [key, value] of Object.entries(entry)) {
        if (SENSITIVE_KEYS.test(key)) continue;
        if (['actor_user_id', 'target_user_id', 'target_meeting_id', 'request_id', 'action', 'result', 'created_at'].includes(key)) safe[key] = value;
      }
      safe.created_at ||= new Date().toISOString();
      if (typeof resolvedRepository?.append === 'function') await resolvedRepository.append(safe);
      return safe;
    }
  });
}
