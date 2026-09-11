import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { AudioLines, Languages, LoaderCircle, Radio, ShieldCheck } from 'lucide-react';
import { supabase, isSupabaseConfigured } from '../lib/supabaseAuth.js';

const AuthContext = createContext({ session: null, profile: null, signOut: async () => {}, switchAccount: async () => {} });

export function useAuth() {
  return useContext(AuthContext);
}

function AuthProductPanel() {
  return (
    <aside className="auth-product-panel" aria-label="即時翻譯產品預覽">
      <div className="auth-product-heading">
        <span className="auth-product-icon"><Languages size={20} aria-hidden="true" /></span>
        <span className="auth-product-kicker">LIVE TRANSLATE</span>
      </div>
      <h2>讓每場會議，跨越語言</h2>
      <p className="auth-product-copy">即時轉錄與翻譯，讓每個人都跟得上對話。</p>

      <div className="auth-preview-card">
        <div className="auth-preview-header">
          <span className="auth-preview-status"><Radio size={14} aria-hidden="true" /> 即時翻譯中</span>
          <span className="auth-preview-direction">繁體中文 <span aria-hidden="true">→</span> English</span>
        </div>
        <div className="auth-cue auth-cue-source">
          <span className="auth-cue-label">原文</span>
          <p>今天先確認下週的發佈時程。</p>
        </div>
        <div className="auth-cue auth-cue-translation">
          <span className="auth-cue-label">翻譯</span>
          <p>Let’s confirm next week’s release schedule.</p>
        </div>
        <div className="auth-preview-footer">
          <AudioLines size={17} aria-hidden="true" />
          <span>字幕會隨著對話即時更新</span>
        </div>
      </div>

      <div className="auth-product-features" aria-label="產品能力">
        <span><Languages size={15} aria-hidden="true" /> 多語翻譯</span>
        <span><AudioLines size={15} aria-hidden="true" /> 即時字幕</span>
        <span><ShieldCheck size={15} aria-hidden="true" /> 安全工作區</span>
      </div>
    </aside>
  );
}

function AuthBrand() {
  return (
    <div className="auth-brand">
      <span className="auth-brand-icon"><Languages size={18} aria-hidden="true" /></span>
      <span>即時翻譯</span>
    </div>
  );
}

function AuthShell({ children }) {
  return (
    <main className="auth-page">
      <div className="auth-shell">
        <section className="auth-panel auth-panel-form" aria-label="Workspace 登入">
          {children}
        </section>
        <AuthProductPanel />
      </div>
    </main>
  );
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
  if (!isSupabaseConfigured()) {
    return (
      <AuthShell>
        <AuthBrand />
        <div className="auth-form-content">
          <p className="auth-eyebrow">WORKSPACE ACCESS</p>
          <h1 id="auth-title">登入服務尚未設定</h1>
          <p className="auth-description">請設定 Supabase 登入後重新載入頁面。</p>
        </div>
      </AuthShell>
    );
  }
  if (loading) {
    return (
      <AuthShell>
        <AuthBrand />
        <div className="auth-loading" role="status" aria-live="polite">
          <LoaderCircle className="auth-loading-icon" size={22} aria-hidden="true" />
          <p>正在檢查登入狀態…</p>
        </div>
      </AuthShell>
    );
  }
  if (!session) {
    return (
      <AuthShell>
        <AuthBrand />
        <div className="auth-form-content">
          <p className="auth-eyebrow">WORKSPACE ACCESS</p>
          <h1 id="auth-title">歡迎回來</h1>
          <p className="auth-description">使用公司 Google Workspace 帳號登入，開始管理會議與即時字幕。</p>
          <button
            className="button auth-google-button"
            type="button"
            onClick={() => supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.origin } })}
          >
            <img src="/google-g.svg" alt="" aria-hidden="true" />
            <span>使用 Google 登入</span>
          </button>
          <p className="auth-security-note"><ShieldCheck size={16} aria-hidden="true" /> 僅開放已授權的 Workspace 網域</p>
        </div>
      </AuthShell>
    );
  }
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
