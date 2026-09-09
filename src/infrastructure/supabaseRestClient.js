export function createSupabaseRestClient({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('Supabase client requires fetch.');
  const baseUrl = String(env.SUPABASE_URL || '').replace(/\/$/u, '');
  const key = env.SUPABASE_SECRET_KEY;
  if (!baseUrl || !key) return null;

  async function request(table, { method = 'GET', query = '', body, headers = {} } = {}) {
    const response = await fetchImpl(`${baseUrl}/rest/v1/${table}${query}`, {
      method,
      headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'return=representation', ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    if (!response.ok) {
      const error = new Error(`Supabase ${method} ${table} failed.`);
      error.status = response.status;
      error.code = response.status === 404 ? 'not_found' : 'cloud_capability_unavailable';
      throw error;
    }
    return response.status === 204 ? [] : response.json();
  }

  return Object.freeze({ request });
}

export function eq(name, value) {
  return `${encodeURIComponent(name)}=eq.${encodeURIComponent(value)}`;
}
