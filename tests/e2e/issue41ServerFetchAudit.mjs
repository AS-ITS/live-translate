import { appendFileSync } from 'node:fs';

const file = process.env.ISSUE41_SERVER_FETCH_AUDIT_FILE;
const origin = process.env.SUPABASE_URL ? new URL(process.env.SUPABASE_URL).origin : null;

if (file && origin) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.origin !== origin) return originalFetch(input, init);
    const method = String(init?.method || input?.method || 'GET').toUpperCase();
    const route = url.pathname.replace(/^(\/rest\/v1\/(?:rpc\/)?[^/]+|\/storage\/v1\/object\/[^/]+).*$/u, '$1');
    let authorizationEvidence = {};
    if (route === '/rest/v1/rpc/activate_pending_profile') {
      let payload = null;
      try { payload = JSON.parse(init?.body); } catch { /* Invalid payload stays invalid. */ }
      const headers = new Headers(init?.headers || input?.headers);
      authorizationEvidence = {
        authorizationPayloadValid: method === 'POST' && payload && !Array.isArray(payload)
          && Object.keys(payload).length === 1
          && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(payload.target_user_id),
        serviceRoleCredential: headers.get('authorization') === `Bearer ${process.env.SUPABASE_SECRET_KEY}`
      };
    }
    try {
      const response = await originalFetch(input, init);
      appendFileSync(file, `${JSON.stringify({ method, route, status: response.status,
        ...authorizationEvidence })}\n`);
      return response;
    } catch (error) {
      appendFileSync(file, `${JSON.stringify({ method, route, status: null, error: 'transport_error',
        ...authorizationEvidence })}\n`);
      throw error;
    }
  };
}
