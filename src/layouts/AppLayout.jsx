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
  return (
    <main className={`app-shell ${className}`.trim()}>
      {showHeader ? (
        <header className={`app-header ${headerClassName}`.trim()}>
          <div className="brand-block">
            <h1 id={titleId}>{title}</h1>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          {headerAction}
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
