export const MEETING_STATUS_FILTERS = Object.freeze([
  { value: 'all', label: '全部狀態' },
  { value: 'created', label: '已建立' },
  { value: 'active', label: '進行中' },
  { value: 'interrupted', label: '已暫停／可繼續' },
  { value: 'completed', label: '已完成' }
]);

export function meetingManagementStatusLabel(status) {
  const labels = {
    created: '已建立',
    active: '進行中',
    interrupted: '已暫停／可繼續',
    completed: '已完成',
    failed: '失敗'
  };

  return labels[status] || status || '未知狀態';
}

export function meetingManagementLastUpdated(meeting = {}) {
  return meeting.updatedAt || meeting.endedAt || meeting.startedAt || meeting.createdAt || null;
}

export function filterMeetingManagementItems(meetings = [], { query = '', status = 'all' } = {}) {
  const normalizedQuery = String(query || '').trim().toLocaleLowerCase();

  return meetings.filter((meeting) => {
    if (status !== 'all' && meeting?.status !== status) return false;
    if (!normalizedQuery) return true;

    return [
      meeting?.name,
      meeting?.id,
      meeting?.status,
      meetingManagementStatusLabel(meeting?.status),
      meeting?.sourceLanguageCode,
      meeting?.targetLanguageCode
    ].filter(Boolean).join(' ').toLocaleLowerCase().includes(normalizedQuery);
  });
}
