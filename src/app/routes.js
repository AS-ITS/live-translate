export const FEATURE_PAGES = new Set([
  'live',
  'live-recording',
  'history',
  'translation-history',
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
  const page = requestedPage === 'live' || requestedPage === 'live-recording'
    ? 'live-recording'
    : requestedPage === 'history'
      ? 'translation-history'
      : requestedPage === 'retranslate'
        ? 'meetings'
        : requestedPage === 'meeting-detail' && meetingId
          ? 'meeting-detail'
          : requestedPage === 'meeting' ? 'meeting-settings' : requestedPage;

  return {
    page,
    sessionId: params.get('sessionId') || '',
    meetingId,
    meetingDetailFrom: params.get('from') || '',
    workspaceTab: params.get('tab') || (requestedPage === 'meeting-detail' ? 'history' : 'live'),
    panel: params.get('panel') || (requestedPage === 'glossary' ? 'global-glossary' : ''),
    recordType: params.get('recordType') || 'session',
    recordId: params.get('recordId') || '',
    historySection: params.get('section') || 'overview',
    createMeeting: params.get('create') === '1',
    settingsMode: params.get('mode') || (params.get('meetingId') ? 'edit' : 'create'),
    statusFilter: params.get('status') || 'all',
    shareToken: params.get('token') || '',
    shareCode: params.get('code') || ''
  };
}

export function canonicalHashForLocation() {
  const rawHash = window.location.hash.replace('#', '');
  const [pageName, queryString = ''] = rawHash.split('?');
  const params = new URLSearchParams(queryString);
  const meetingId = params.get('meetingId') || '';
  if (pageName === 'live' || pageName === 'live-recording') {
    return meetingId
      ? `#live?meetingId=${encodeURIComponent(meetingId)}`
      : '#live';
  }
  if (pageName === 'meeting-workspace' && params.get('tab') === 'live' && meetingId) {
    return `#live?meetingId=${encodeURIComponent(meetingId)}`;
  }
  if (pageName === 'history') return window.location.hash.replace(/^#history/, '#translation-history');
  if (pageName === 'retranslate') return '#meetings';
  if (pageName === 'glossary') return '#glossary';
  if (pageName === 'meeting-detail' && meetingId) {
    return `#meeting-detail?meetingId=${encodeURIComponent(meetingId)}&from=${encodeURIComponent(params.get('from') || 'meetings')}`;
  }
  return window.location.hash || '#meetings';
}
