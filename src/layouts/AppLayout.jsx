import {
  ArrowRight,
  ChevronDown,
  ClipboardList,
  KeyRound,
  LogOut,
  Menu,
  RefreshCw,
  UserRound,
  UsersRound,
  X
} from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useAuth } from '../components/AuthGate.jsx';
import { GEMINI_SETTINGS_HASH, isHeaderFeaturePage } from '../app/routes.js';
import { hasLiveCredential, subscribeToLiveCredentialClear } from '../lib/liveCredentialHolder.js';

const MOBILE_MENU_MEDIA_QUERY = '(min-width: 901px)';
const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function AppLayout({
  children,
  className = '',
  title,
  titleId,
  subtitle,
  headerAction = null,
  showHeader = true,
  showHeaderActions = true,
  headerClassName = ''
}) {
  const { profile, signOut, switchAccount } = useAuth();
  const accountMenuRef = useRef(null);
  const accountTriggerRef = useRef(null);
  const mobileMenuButtonRef = useRef(null);
  const mobileMenuPanelRef = useRef(null);
  const wasMobileMenuOpenRef = useRef(false);
  const mobileMenuId = useId();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [hasGeminiCredential, setHasGeminiCredential] = useState(hasLiveCredential);
  const showHeaderFeatureActions = !isHeaderFeaturePage();

  function closeMobileMenu() {
    setMobileMenuOpen(false);
  }

  useEffect(() => subscribeToLiveCredentialClear(() => setHasGeminiCredential(false)), []);

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

  useEffect(() => {
    function closeOnRouteChange() {
      setMobileMenuOpen(false);
    }

    window.addEventListener('hashchange', closeOnRouteChange);
    return () => window.removeEventListener('hashchange', closeOnRouteChange);
  }, []);

  useEffect(() => {
    const mediaQuery = window.matchMedia(MOBILE_MENU_MEDIA_QUERY);
    const closeOnDesktop = (event) => {
      if (event.matches) setMobileMenuOpen(false);
    };

    mediaQuery.addEventListener?.('change', closeOnDesktop);
    return () => mediaQuery.removeEventListener?.('change', closeOnDesktop);
  }, []);

  useEffect(() => {
    if (!mobileMenuOpen) {
      if (wasMobileMenuOpenRef.current) mobileMenuButtonRef.current?.focus();
      wasMobileMenuOpenRef.current = false;
      return undefined;
    }

    wasMobileMenuOpenRef.current = true;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const panel = mobileMenuPanelRef.current;
    const focusFirstItem = () => panel?.querySelector(FOCUSABLE_SELECTOR)?.focus();
    const animationFrame = window.requestAnimationFrame(focusFirstItem);

    function trapFocus(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMobileMenu();
        return;
      }
      if (event.key !== 'Tab' || !panel) return;
      const focusable = [...panel.querySelectorAll(FOCUSABLE_SELECTOR)];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', trapFocus);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      document.removeEventListener('keydown', trapFocus);
      document.body.style.overflow = previousOverflow;
    };
  }, [mobileMenuOpen]);

  const headerLinks = showHeaderFeatureActions ? (
    <>
      {profile ? <a className={`button secondary header-key-action${hasGeminiCredential ? '' : ' is-missing'}`} href={GEMINI_SETTINGS_HASH} onClick={closeMobileMenu}><KeyRound size={16} aria-hidden="true" />Gemini Key</a> : null}
      {profile?.role === 'super_admin' ? <a className="button secondary header-key-action" href="#admin" onClick={closeMobileMenu}><UsersRound size={16} aria-hidden="true" />帳號管理</a> : null}
      {profile?.role === 'super_admin' ? <a className="button secondary header-key-action" href="#audit" onClick={closeMobileMenu}><ClipboardList size={16} aria-hidden="true" />稽核紀錄</a> : null}
    </>
  ) : null;

  const mobileAccount = profile ? (
    <section className="mobile-nav-account" aria-labelledby={`${mobileMenuId}-account`}>
      <h3 id={`${mobileMenuId}-account`}>帳號</h3>
      <p className="account-menu-email">{profile.email}</p>
      <button className="account-menu-switch" type="button" onClick={() => { closeMobileMenu(); void switchAccount?.(); }}>
        <RefreshCw size={16} aria-hidden="true" />切換帳號
      </button>
      <button className="account-menu-logout" type="button" onClick={() => { closeMobileMenu(); void signOut?.(); }}>
        <LogOut size={16} aria-hidden="true" />登出
      </button>
    </section>
  ) : null;

  return (
    <main className={`app-shell ${className}`.trim()}>
      {showHeader ? <header className={`app-header ${headerClassName}`.trim()}>
        <div className="app-header-bar">
          <div className="brand-block">
            <h1 id={titleId}>{title}</h1>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          {showHeaderActions ? <button
            ref={mobileMenuButtonRef}
            className="mobile-menu-trigger"
            type="button"
            aria-label="開啟導覽選單"
            aria-expanded={mobileMenuOpen}
            aria-controls={mobileMenuId}
            onClick={() => setMobileMenuOpen((open) => !open)}
          >
            <Menu size={22} aria-hidden="true" />
          </button> : null}
        </div>
        {showHeaderActions ? <div className="app-header-actions">
          {headerLinks}
          {profile ? <details ref={accountMenuRef} className="account-menu">
            <summary ref={accountTriggerRef} className="account-menu-trigger" aria-label="開啟帳號選單">
              <UserRound size={17} aria-hidden="true" />
              <span>{profile.fullName || '帳號'}</span>
              <ChevronDown size={16} aria-hidden="true" />
            </summary>
            <div className="account-menu-panel" role="menu">
              <p className="account-menu-email">{profile.email}</p>
              <button className="account-menu-switch" type="button" role="menuitem" onClick={() => { accountMenuRef.current?.removeAttribute('open'); void switchAccount?.(); }}>
                <RefreshCw size={16} aria-hidden="true" />切換帳號
              </button>
              <button className="account-menu-logout" type="button" role="menuitem" onClick={signOut}>
                <LogOut size={16} aria-hidden="true" />登出
              </button>
            </div>
          </details> : null}
          {headerAction}
        </div> : null}
      </header> : null}
      {mobileMenuOpen ? <>
        <button className="mobile-nav-backdrop" type="button" aria-label="關閉導覽選單" onClick={closeMobileMenu} />
        <aside ref={mobileMenuPanelRef} id={mobileMenuId} className="mobile-nav-panel" aria-labelledby={`${mobileMenuId}-title`} aria-modal="true" role="dialog" onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            closeMobileMenu();
          }
        }}>
          <div className="mobile-nav-panel-header">
            <h2 id={`${mobileMenuId}-title`}>導覽選單</h2>
            <button className="mobile-nav-close" type="button" aria-label="關閉導覽選單" onClick={closeMobileMenu}><X size={22} aria-hidden="true" /></button>
          </div>
          <nav className="mobile-nav-links" aria-label="主要導覽">
            {headerLinks}
            {headerAction ? <div className="mobile-nav-primary">{headerAction}</div> : null}
          </nav>
          {mobileAccount}
        </aside>
      </> : null}
      {children}
    </main>
  );
}

export function MeetingLayout({ children, title, titleId, subtitle, headerAction = null, className = '', managementShell = false }) {
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
      showHeaderActions={false}
    >
      {children}
    </AppLayout>
  );
}
