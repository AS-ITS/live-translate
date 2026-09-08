export function AppRouter({ page, views }) {
  if (page === 'viewer') return views.viewer();
  if (page === 'meeting-settings') return views.meetingSettings();
  return views.workspace();
}
