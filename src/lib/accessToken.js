import { supabase } from './supabaseAuth.js';

export async function accessTokenHeaders(headers = {}, supabaseClient = supabase) {
  const nextHeaders = { ...headers };
  const session = await currentSession(supabaseClient);
  if (session?.access_token) nextHeaders.Authorization = `Bearer ${session.access_token}`;
  return nextHeaders;
}

export async function currentSession(supabaseClient = supabase) {
  if (!supabaseClient?.auth?.getSession) return null;
  const { data } = await supabaseClient.auth.getSession();
  let session = data?.session || null;
  const expiresAt = Number(session?.expires_at || 0) * 1000;
  if (session && expiresAt > 0 && expiresAt <= Date.now() + 30_000 && typeof supabaseClient.auth.refreshSession === 'function') {
    try {
      const refreshed = await supabaseClient.auth.refreshSession();
      session = refreshed.data?.session || session;
    } catch {
      // Let the API return auth_invalid so authenticatedFetch can clear the session.
    }
  }
  return session;
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
