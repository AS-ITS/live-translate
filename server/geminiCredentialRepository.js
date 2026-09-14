const CREDENTIAL_ERROR = 'gemini_credential_unavailable';

export function createGeminiCredentialRepository({
  env = process.env,
  fetchImpl = globalThis.fetch
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('credential repository requires fetch.');

  const baseUrl = String(env.SUPABASE_URL || '').replace(/\/$/u, '');
  const serviceKey = env.SUPABASE_SECRET_KEY;

  if (!baseUrl || !serviceKey) return null;

  async function callRpc(name, body) {
    if (!baseUrl || !serviceKey) throw unavailable();
    const response = await fetchImpl(`${baseUrl}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    if (!response.ok) throw unavailable();
    return response.status === 204 ? null : response.json();
  }

  return Object.freeze({
    async get(userId) {
      assertUserId(userId);
      const result = await callRpc('get_my_gemini_credential', { requested_user_id: userId });
      return result?.[0] || result || null;
    },

    async resolveKey(userId) {
      assertUserId(userId);
      const result = await callRpc('read_my_gemini_key', { requested_user_id: userId });
      return result?.[0]?.api_key || result?.api_key || null;
    },

    async upsert(userId, apiKey) {
      assertUserId(userId);
      if (typeof apiKey !== 'string' || apiKey.trim().length < 10) {
        const error = new Error('Gemini API Key is invalid.');
        error.code = 'gemini_credential_invalid';
        error.status = 400;
        throw error;
      }
      const result = await callRpc('upsert_my_gemini_credential', {
        requested_user_id: userId,
        plaintext_key: apiKey.trim()
      });
      return result?.[0] || result || null;
    },

    async remove(userId) {
      assertUserId(userId);
      await callRpc('delete_my_gemini_credential', { requested_user_id: userId });
    }
  });
}

function assertUserId(userId) {
  if (typeof userId !== 'string' || userId.trim() === '') {
    const error = new Error('Authenticated user is required.');
    error.code = 'auth_required';
    error.status = 401;
    throw error;
  }
}

function unavailable() {
  const error = new Error('Gemini credential repository is not configured.');
  error.code = CREDENTIAL_ERROR;
  error.status = 503;
  return error;
}
