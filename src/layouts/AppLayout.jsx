import { ArrowRight, ChevronDown, KeyRound, LogOut, RefreshCw, UserRound } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useAuth } from '../components/AuthGate.jsx';
import { GEMINI_SETTINGS_HASH } from '../app/routes.js';

export function AppLayout({
  children,
  className = '',
  title,
  titleId,
  subtitle,
  headerAction = null,
  showHeader = true,
  showGeminiKeyAction = true,
  headerClassName = ''
}) {
  const { profile, signOut, switchAccount } = useAuth();
  const accountMenuRef = useRef(null);
  const accountTriggerRef = useRef(null);

  useEffect(() => {
    function closeOnOutsidePointer(event) {
      if (!accountMenuRef.current?.contains(event.target)) accountMenuRef.current?.removeAttribute('open');
    }

    function closeOnEscape(event) {
      if (event.key !== 'Escape' || !accountMenuRef.current?.open) return;
      accountMenuRef.current.removeAttribute('open');
      accountTriggerRef.current?.focus();
    }

    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, []);
  return (
    <main className={`app-shell ${className}`.trim()}>
      {showHeader ? (
        <header className={`app-header ${headerClassName}`.trim()}>
          <div className="brand-block">
            <h1 id={titleId}>{title}</h1>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          <div className="app-header-actions">
            {profile && showGeminiKeyAction ? <a className="button secondary header-key-action" href={GEMINI_SETTINGS_HASH}><KeyRound size={16} aria-hidden="true" />Gemini Key</a> : null}
            {profile ? (
              <details ref={accountMenuRef} className="account-menu">
                <summary ref={accountTriggerRef} className="account-menu-trigger" aria-label="開啟帳號選單">
                  <UserRound size={17} aria-hidden="true" />
                  <span>{profile.fullName || '帳號'}</span>
                  <ChevronDown size={16} aria-hidden="true" />
                </summary>
                <div className="account-menu-panel" role="menu">
                  <p className="account-menu-email">{profile.email}</p>
                  <button className="account-menu-switch" type="button" role="menuitem" onClick={() => { accountMenuRef.current?.removeAttribute('open'); void switchAccount?.(); }}>
                    <RefreshCw size={16} aria-hidden="true" />
                    切換帳號
                  </button>
                  <button className="account-menu-logout" type="button" role="menuitem" onClick={signOut}>
                    <LogOut size={16} aria-hidden="true" />
                    登出
                  </button>
                </div>
              </details>
            ) : null}
            {headerAction}
          </div>
        </header>
      ) : null}
      {children}
    </main>
  );
}

export function MeetingLayout({
  children,
  title,
  titleId,
  subtitle,
  headerAction = null,
  className = '',
  managementShell = false
}) {
  return (
    <AppLayout
      className={`meeting-app-shell${managementShell ? ' meeting-management-shell' : ''} ${className}`.trim()}
      title={title}
      titleId={titleId}
      subtitle={subtitle}
      headerAction={headerAction}
      headerClassName="meeting-app-header"
    >
      {children}
    </AppLayout>
  );
}

export function MeetingSettingsLayout({ children, mode = 'create', onBack }) {
  const isEdit = mode === 'edit';
  return (
    <AppLayout
      className="meeting-app-shell meeting-settings-shell meeting-management-shell"
      title={isEdit ? '編輯會議設定' : '建立會議'}
      titleId="meeting-settings-title"
      subtitle="設定完成後即可取得分享連結。"
      headerAction={<button className="button secondary meeting-header-action" type="button" onClick={onBack}><ArrowRight size={18} aria-hidden="true" />返回會議管理</button>}
      headerClassName="meeting-app-header meeting-settings-header"
    >
      {children}
    </AppLayout>
  );
}

export function PublicSessionLayout({ children, className = '', title, subtitle, status }) {
  return (
    <AppLayout
      className={`watch-page ${className}`.trim()}
      title={title}
      subtitle={subtitle}
      headerAction={status ? <span className="status-pill">{status}</span> : null}
    >
      {children}
    </AppLayout>
  );
}
