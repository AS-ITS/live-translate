import { ArrowRight } from 'lucide-react';
import { useAuth } from '../components/AuthGate.jsx';

export function AppLayout({
  children,
  className = '',
  title,
  titleId,
  subtitle,
  headerAction = null,
  showHeader = true,
  headerClassName = ''
}) {
  const { profile, signOut } = useAuth();
  return (
    <main className={`app-shell ${className}`.trim()}>
      {showHeader ? (
        <header className={`app-header ${headerClassName}`.trim()}>
          <div className="brand-block">
            <h1 id={titleId}>{title}</h1>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          <div className="app-header-actions">{profile ? <span className="profile-chip">{profile.fullName || profile.email}</span> : null}{profile ? <button className="button secondary" type="button" onClick={signOut}>登出</button> : null}{headerAction}</div>
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
