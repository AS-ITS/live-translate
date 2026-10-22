// E2E-only Supabase client identity. The .invalid host cannot reach a real project.
export const E2E_SUPABASE_URL = 'http://e2e-auth.invalid';
export const E2E_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_e2e_fixture_only';
const E2E_SUPABASE_STORAGE_KEY = `sb-${new URL(E2E_SUPABASE_URL).hostname.split('.')[0]}-auth-token`;

export async function installE2EAuth(page, profile = { id: 'owner-1', email: 'owner@example.com', role: 'owner', status: 'active' }) {
  await page.addInitScript(({ profile: sessionProfile, storageKey }) => {
    window.__liveTranslateE2EAuthEvents = true;
    const session = {
      access_token: 'e2e-access-token', refresh_token: 'e2e-refresh-token', token_type: 'bearer',
      expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id: sessionProfile.id, email: sessionProfile.email, role: 'authenticated' }
    };
    for (const key of Object.keys(localStorage)) {
      if (/^sb-.*-auth-token$/u.test(key)) localStorage.removeItem(key);
    }
    localStorage.setItem(storageKey, JSON.stringify(session));
  }, { profile, storageKey: E2E_SUPABASE_STORAGE_KEY });
  await page.route('**/api/profile', async (route) => route.fulfill({ json: { profile } }));
}

export async function emitE2EAuthState(page, event, overrides = {}) {
  await page.evaluate(({ authEvent, sessionOverrides, storageKey }) => {
    const stored = JSON.parse(localStorage.getItem(storageKey) || 'null');
    const nextSession = sessionOverrides === null ? null : { ...stored, ...sessionOverrides };
    if (nextSession) localStorage.setItem(storageKey, JSON.stringify(nextSession));
    else localStorage.removeItem(storageKey);
    window.dispatchEvent(new CustomEvent('live-translate:e2e-auth-state', {
      detail: { event: authEvent, session: nextSession }
    }));
  }, { authEvent: event, sessionOverrides: overrides, storageKey: E2E_SUPABASE_STORAGE_KEY });
}
