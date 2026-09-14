export function AppRouter({ page, views }) {
  if (page === 'viewer') return views.viewer();
  if (page === 'meeting-settings') return views.meetingSettings();
  if (page === 'settings') return views.settings();
  if (page === 'admin') return views.admin();
  return views.workspace();
}
