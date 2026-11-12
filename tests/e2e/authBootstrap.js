// E2E-only Supabase client identity. The .invalid host cannot reach a real project.
export const E2E_SUPABASE_URL = 'http://e2e-auth.invalid';
export const E2E_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_e2e_fixture_only';

export function localE2EAuthSession() {
  const token = process.env.E2E_LOCAL_ACCESS_TOKEN;
  if (!token) return null;
  const url = new URL(process.env.SUPABASE_URL);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) {
    throw new Error('Local E2E auth requires a loopback SUPABASE_URL.');
  }
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  if (claims.iss !== `${url.origin}/auth/v1` || claims.role !== 'authenticated' ||
      !claims.sub || !claims.email?.startsWith('issue41-e2e-') ||
      !Number.isFinite(claims.exp) || claims.exp <= Date.now() / 1000) {
    throw new Error('E2E_LOCAL_ACCESS_TOKEN must be a current local Supabase user token.');
  }
  return {
    token,
    profile: { id: claims.sub, email: claims.email, role: 'owner', status: 'active' },
    storageKey: `sb-${url.hostname.split('.')[0]}-auth-token`,
    expiresAt: claims.exp,
    refreshToken: process.env.E2E_LOCAL_REFRESH_TOKEN || null
  };
}
const E2E_SUPABASE_STORAGE_KEY = `sb-${new URL(E2E_SUPABASE_URL).hostname.split('.')[0]}-auth-token`;

export async function installE2EAuth(page, profile = { id: 'owner-1', email: 'owner@example.com', role: 'owner', status: 'active' }) {
  const localSession = localE2EAuthSession();
  await page.addInitScript(({ profile: sessionProfile, storageKey, token, refreshToken, expiresAt }) => {
    window.__liveTranslateE2EAuthEvents = true;
    const session = {
      access_token: token, refresh_token: refreshToken || 'e2e-refresh-token', token_type: 'bearer',
      expires_in: expiresAt - Math.floor(Date.now() / 1000), expires_at: expiresAt,
      user: { id: sessionProfile.id, email: sessionProfile.email, role: 'authenticated' }
    };
    for (const key of Object.keys(localStorage)) {
      if (/^sb-.*-auth-token$/u.test(key)) localStorage.removeItem(key);
    }
    localStorage.setItem(storageKey, JSON.stringify(session));
  }, {
    profile: localSession?.profile || profile,
    storageKey: localSession?.storageKey || E2E_SUPABASE_STORAGE_KEY,
    token: localSession?.token || 'e2e-access-token',
    refreshToken: localSession?.refreshToken || null,
    expiresAt: localSession?.expiresAt || Math.floor(Date.now() / 1000) + 3600
  });
  if (!localSession) await page.route('**/api/profile', async (route) => route.fulfill({ json: { profile } }));
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
  }, { authEvent: event, sessionOverrides: overrides, storageKey: localE2EAuthSession()?.storageKey || E2E_SUPABASE_STORAGE_KEY });
}
