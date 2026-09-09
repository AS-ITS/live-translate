import { supabase, currentSupabaseSession } from './supabaseAuth.js';

export function accessTokenHeaders(headers = {}) {
  const nextHeaders = { ...headers };
  if (currentSupabaseSession?.access_token) nextHeaders.Authorization = `Bearer ${currentSupabaseSession.access_token}`;
  return nextHeaders;
}

export function authenticatedFetch(fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw new TypeError('authenticated fetch requires fetchImpl to be a function.');
  return async (url, init = {}) => {
    const { data } = supabase ? await supabase.auth.getSession() : { data: { session: null } };
    const headers = { ...(init.headers || {}) };
    if (data.session?.access_token) headers.Authorization = `Bearer ${data.session.access_token}`;
    return fetchImpl(url, { ...init, headers });
  };
}
