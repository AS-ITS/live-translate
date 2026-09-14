export function createSupabaseRestClient({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('Supabase client requires fetch.');
  const baseUrl = String(env.SUPABASE_URL || '').replace(/\/$/u, '');
  const key = env.SUPABASE_SECRET_KEY;
  if (!baseUrl || !key) return null;

  async function request(table, { method = 'GET', query = '', body, headers = {} } = {}) {
    let response;
    try {
      response = await fetchImpl(`${baseUrl}/rest/v1/${table}${query}`, {
      method,
      headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'return=representation', ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
    } catch (cause) {
      const error = new Error('Supabase REST endpoint is unavailable.');
      error.code = 'supabase_unavailable';
      error.status = 503;
      error.cause = cause;
      throw error;
    }
    if (!response.ok) {
      const error = new Error(`Supabase ${method} ${table} request failed.`);
      error.status = response.status;
      error.code = response.status === 404
        ? 'supabase_schema_missing'
        : (response.status === 401 || response.status === 403
          ? 'supabase_credentials_invalid'
          : 'supabase_request_failed');
      throw error;
    }
    return response.status === 204 ? [] : response.json();
  }

  async function healthCheck({ tables = [] } = {}) {
    for (const table of tables) await request(table, { query: '?select=*&limit=0' });
    return { ok: true, tables };
  }

  async function rpc(functionName, body = {}) {
    let response;
    try {
      response = await fetchImpl(`${baseUrl}/rest/v1/rpc/${functionName}`, {
        method: 'POST',
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          ...headersForRpc()
        },
        body: JSON.stringify(body)
      });
    } catch (cause) {
      const error = new Error('Supabase RPC endpoint is unavailable.');
      error.code = 'supabase_unavailable';
      error.status = 503;
      error.cause = cause;
      throw error;
    }
    if (!response.ok) {
      const error = new Error(`Supabase RPC ${functionName} failed.`);
      error.status = response.status;
      error.code = response.status === 404
        ? 'supabase_schema_missing'
        : (response.status === 401 || response.status === 403
          ? 'supabase_credentials_invalid'
          : 'supabase_request_failed');
      throw error;
    }
    return response.status === 204 ? [] : response.json();
  }

  function headersForRpc() {
    return { Prefer: 'return=representation' };
  }

  return Object.freeze({ request, rpc, healthCheck, baseUrl });
}

export function eq(name, value) {
  return `${encodeURIComponent(name)}=eq.${encodeURIComponent(value)}`;
}
