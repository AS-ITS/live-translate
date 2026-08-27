export const FEATURE_PAGES = new Set([
  'live',
  'history',
  'meetings',
  'meeting',
  'meeting-settings',
  'meeting-detail',
  'meeting-workspace',
  'retranslate',
  'glossary',
  'watch',
  'viewer',
  'record',
  'dead-letter-queue'
]);

export function pageFromLocation() {
  return pageInfoFromLocation().page;
}

export function pageInfoFromLocation() {
  const rawHash = window.location.hash.replace('#', '');
  const [pageName, queryString = ''] = rawHash.split('?');
  const params = new URLSearchParams(queryString);
  const requestedPage = FEATURE_PAGES.has(pageName) ? pageName : pageName ? 'live' : 'meetings';
  const meetingId = params.get('meetingId') || '';
  const page = requestedPage === 'live'
    ? (meetingId ? 'meeting-workspace' : 'meetings')
    : ['history', 'retranslate'].includes(requestedPage)
      ? 'meetings'
      : requestedPage === 'meeting-detail' && meetingId
        ? 'meeting-workspace'
      : requestedPage === 'meeting' ? 'meeting-settings' : requestedPage;

  return {
    page,
    sessionId: params.get('sessionId') || '',
    meetingId,
    meetingDetailFrom: params.get('from') || '',
    workspaceTab: params.get('tab') || (requestedPage === 'meeting-detail' ? 'history' : 'live'),
    panel: params.get('panel') || (requestedPage === 'glossary' ? 'global-glossary' : ''),
    createMeeting: params.get('create') === '1',
    settingsMode: params.get('mode') || (params.get('meetingId') ? 'edit' : 'create'),
    statusFilter: params.get('status') || (requestedPage === 'history' ? 'completed' : 'all'),
    shareToken: params.get('token') || '',
    shareCode: params.get('code') || ''
  };
}

export function canonicalHashForLocation() {
  const rawHash = window.location.hash.replace('#', '');
  const [pageName, queryString = ''] = rawHash.split('?');
  const params = new URLSearchParams(queryString);
  const meetingId = params.get('meetingId') || '';
  if (pageName === 'live') {
    return meetingId
      ? `#meeting-workspace?meetingId=${encodeURIComponent(meetingId)}&tab=live`
      : '#meetings';
  }
  if (pageName === 'history') return '#meetings?status=completed';
  if (pageName === 'retranslate') return '#meetings';
  if (pageName === 'glossary') return '#glossary';
  if (pageName === 'meeting-detail' && meetingId) {
    return `#meeting-workspace?meetingId=${encodeURIComponent(meetingId)}&tab=${encodeURIComponent(params.get('tab') || 'history')}`;
  }
  return window.location.hash || '#meetings';
}
