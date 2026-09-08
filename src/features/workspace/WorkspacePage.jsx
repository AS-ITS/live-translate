import React from 'react';
import { MeetingLayout } from '../../layouts/AppLayout.jsx';

/**
 * Shared authenticated workspace shell.
 *
 * Route-specific controllers stay outside this presentation boundary until
 * their dependencies have been extracted from the application composition
 * root. This keeps the first migration step behavior-preserving.
 */
export function WorkspacePage({
  children,
  managementShell = false,
  className = '',
  title,
  titleId,
  subtitle,
  headerAction = null,
  headerClassName = ''
}) {
  return (
    <MeetingLayout
      managementShell={managementShell}
      className={className}
      title={title}
      titleId={titleId}
      subtitle={subtitle}
      headerAction={headerAction}
      headerClassName={headerClassName}
    >
      {children}
    </MeetingLayout>
  );
}
