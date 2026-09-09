export function AppRouter({ page, views }) {
  if (page === 'viewer') return views.viewer();
  if (page === 'meeting-settings') return views.meetingSettings();
  if (page === 'settings') return views.settings();
  return views.workspace();
}
