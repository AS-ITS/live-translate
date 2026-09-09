import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { supabase, isSupabaseConfigured } from '../lib/supabaseAuth.js';

const AuthContext = createContext({ session: null, profile: null, signOut: async () => {}, switchAccount: async () => {} });

export function useAuth() {
  return useContext(AuthContext);
}

export function AuthGate({ children }) {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(Boolean(supabase));

  useEffect(() => {
    if (!supabase) return undefined;
    let active = true;
    supabase.auth.getSession().then(({ data }) => {
      if (active) { setSession(data.session); setLoading(false); }
    });
    const { data: subscription } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setLoading(false);
    });
    return () => { active = false; subscription.subscription.unsubscribe(); };
  }, []);

  useEffect(() => {
    if (!session?.access_token) { setProfile(null); return; }
    let active = true;
    fetch('/api/profile', { headers: { Authorization: `Bearer ${session.access_token}` } })
      .then((response) => response.ok ? response.json() : null)
      .then((body) => { if (active) setProfile(body?.profile || null); })
      .catch(() => { if (active) setProfile(null); });
    return () => { active = false; };
  }, [session?.access_token]);

  const value = useMemo(() => ({
    session,
    profile,
    signOut: () => supabase?.auth.signOut(),
    switchAccount: () => supabase?.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: window.location.origin,
        queryParams: { prompt: 'select_account' }
      }
    })
  }), [session, profile]);
  if (!isSupabaseConfigured()) return children;
  if (loading) return <main className="auth-page"><p>正在檢查登入狀態…</p></main>;
  if (!session) {
    return <main className="auth-page"><section className="auth-card"><h1>即時翻譯</h1><p>請使用 Workspace Google 帳號登入。</p><button className="button primary" type="button" onClick={() => supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.origin } })}>使用 Google 登入</button></section></main>;
  }
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
