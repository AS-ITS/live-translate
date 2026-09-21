export function createSupabaseServiceRoleClient({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
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
      error.supabaseStatus = response.status;
      error.code = response.status === 404
        ? 'supabase_schema_missing'
        : (response.status === 401 || response.status === 403
          ? 'supabase_credentials_invalid'
          : 'supabase_request_failed');
      throw error;
    }
    return response.status === 204 ? [] : response.json();
  }

  async function healthCheck({ tables = [], rpcFunctions = [], storageBuckets = [] } = {}) {
    for (const table of tables) await request(table, { query: '?select=*&limit=0' });
    for (const rpcCheck of rpcFunctions) {
      const check = typeof rpcCheck === 'string' ? { name: rpcCheck, body: {} } : rpcCheck;
      await rpc(check.name, check.body || {});
    }
    for (const bucketId of storageBuckets) await storageBucket(bucketId);
    return {
      ok: true,
      tables,
      rpcFunctions: rpcFunctions.map((rpcCheck) => typeof rpcCheck === 'string' ? rpcCheck : rpcCheck.name),
      storageBuckets
    };
  }

  async function storageBucket(bucketId) {
    const normalizedBucketId = encodeURIComponent(String(bucketId || '').trim());
    if (!normalizedBucketId) throw new TypeError('Supabase storage bucket id is required.');

    let response;
    try {
      response = await fetchImpl(`${baseUrl}/storage/v1/bucket/${normalizedBucketId}`, {
        method: 'GET',
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`
        }
      });
    } catch (cause) {
      const error = new Error('Supabase Storage endpoint is unavailable.');
      error.code = 'supabase_unavailable';
      error.status = 503;
      error.cause = cause;
      throw error;
    }

    if (!response.ok) {
      const error = new Error(`Supabase Storage bucket ${bucketId} request failed.`);
      error.status = response.status;
      error.supabaseStatus = response.status;
      error.code = response.status === 404
        ? 'supabase_storage_missing'
        : (response.status === 401 || response.status === 403
          ? 'supabase_credentials_invalid'
          : 'supabase_request_failed');
      throw error;
    }

    return response.status === 204 ? {} : response.json();
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
      error.supabaseStatus = response.status;
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

  return Object.freeze({ request, rpc, healthCheck, storageBucket, baseUrl });
}

export function createSupabaseUserClient({ env = process.env, fetchImpl = globalThis.fetch, accessToken } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('Supabase client requires fetch.');
  const baseUrl = String(env.SUPABASE_URL || '').replace(/\/$/u, '');
  const key = env.VITE_SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_PUBLISHABLE_KEY;
  if (!baseUrl || !key || !String(accessToken || '').trim()) return null;

  async function request(table, { method = 'GET', query = '', body, headers = {} } = {}) {
    let response;
    try {
      response = await fetchImpl(`${baseUrl}/rest/v1/${table}${query}`, {
        method,
        headers: {
          apikey: key,
          Authorization: `Bearer ${accessToken}`,
          Prefer: 'return=representation',
          ...headers,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
        },
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
      error.supabaseStatus = response.status;
      error.code = response.status === 404
        ? 'supabase_schema_missing'
        : (response.status === 401
          ? 'auth_invalid'
          : (response.status === 403 ? 'auth_forbidden' : 'supabase_request_failed'));
      throw error;
    }
    return response.status === 204 ? [] : response.json();
  }

  async function rpc(functionName, body = {}) {
    let response;
    try {
      response = await fetchImpl(`${baseUrl}/rest/v1/rpc/${functionName}`, {
        method: 'POST',
        headers: {
          apikey: key,
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation'
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
      const error = new Error(`Supabase RPC ${functionName} request failed.`);
      error.status = response.status;
      error.supabaseStatus = response.status;
      error.code = response.status === 401 ? 'auth_invalid'
        : (response.status === 403 ? 'auth_forbidden'
          : (response.status === 404 ? 'supabase_schema_missing' : 'supabase_request_failed'));
      throw error;
    }
    return response.status === 204 ? [] : response.json();
  }

  return Object.freeze({ request, rpc, baseUrl });
}

export function eq(name, value) {
  return `${encodeURIComponent(name)}=eq.${encodeURIComponent(value)}`;
}
