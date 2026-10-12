import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env?.VITE_SUPABASE_URL;
const supabasePublishableKey = import.meta.env?.VITE_SUPABASE_PUBLISHABLE_KEY;
const validSupabaseUrl = typeof supabaseUrl === 'string' && (() => {
  try {
    return ['http:', 'https:'].includes(new URL(supabaseUrl).protocol);
  } catch {
    return false;
  }
})();

export const supabase = validSupabaseUrl && supabasePublishableKey
  ? createClient(supabaseUrl, supabasePublishableKey, {
      auth: {
        flowType: 'pkce',
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null;

export function createSupabaseViewerRealtimeClient(accessToken) {
  if (!validSupabaseUrl || !supabasePublishableKey || typeof accessToken !== 'function') return null;
  return createClient(supabaseUrl, supabasePublishableKey, { accessToken });
}

export function isSupabaseConfigured() {
  return Boolean(supabase);
}
