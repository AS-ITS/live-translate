import { createSupabaseServiceRoleClient } from './supabaseRestClient.js';

export function createSupabaseMeetingPurgeStorage({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const client = createSupabaseServiceRoleClient({ env, fetchImpl });
  const baseUrl = String(env.SUPABASE_URL || '').replace(/\/$/u, '');
  const secretKey = env.SUPABASE_SECRET_KEY;
  if (!client || !baseUrl || !secretKey || typeof fetchImpl !== 'function') return null;

  return Object.freeze({
    async remove({ bucket, paths = [] }) {
      if (!Array.isArray(paths) || paths.length === 0) return true;
      const response = await fetchImpl(`${baseUrl}/storage/v1/object/${encodeURIComponent(bucket)}`, {
        method: 'DELETE',
        headers: {
          apikey: secretKey,
          Authorization: `Bearer ${secretKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ prefixes: paths })
      });
      if (!response.ok) {
        const error = new Error('Meeting purge Storage deletion failed.');
        error.code = 'purge_storage_delete_failed';
        error.status = 503;
        throw error;
      }
      return true;
    }
  });
}
