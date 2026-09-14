import { supabase } from './supabaseAuth.js';

export async function accessTokenHeaders(headers = {}, supabaseClient = supabase) {
  const nextHeaders = { ...headers };
  const { data } = supabaseClient
    ? await supabaseClient.auth.getSession()
    : { data: { session: null } };
  if (data.session?.access_token) nextHeaders.Authorization = `Bearer ${data.session.access_token}`;
  return nextHeaders;
}

export function authenticatedFetch(fetchImpl = globalThis.fetch, supabaseClient = supabase) {
  if (typeof fetchImpl !== 'function') throw new TypeError('authenticated fetch requires fetchImpl to be a function.');
  return async (url, init = {}) => {
    const headers = await accessTokenHeaders(init.headers || {}, supabaseClient);
    const response = await fetchImpl(url, { ...init, headers });
    if (supabaseClient && typeof response?.clone === 'function') {
      try {
        const body = await response.clone().json();
        const code = body?.error?.code || body?.code;
        if (code === 'auth_required' || code === 'auth_invalid') await supabaseClient.auth.signOut();
      } catch {
        // Preserve the original response when an auth error is not JSON.
      }
    }
    return response;
  };
}
