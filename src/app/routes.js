export const FEATURE_PAGES = new Set([
  'live',
  'meetings',
  'meeting-settings',
  'meeting-detail',
  'glossary',
  'viewer'
]);

export function pageFromLocation() {
  return pageInfoFromLocation().page;
}

export function pageInfoFromLocation() {
  const rawHash = window.location.hash.replace('#', '');
  const [pageName, queryString = ''] = rawHash.split('?');
  const params = new URLSearchParams(queryString);
  const requestedPage = FEATURE_PAGES.has(pageName) ? pageName : 'meetings';
  const meetingId = params.get('meetingId') || '';
  const page = requestedPage === 'live'
    ? 'live-recording'
    : requestedPage === 'meeting-detail' && meetingId
      ? 'meeting-detail'
      : requestedPage;

  return {
    page,
    sessionId: params.get('sessionId') || '',
    meetingId,
    meetingDetailFrom: params.get('from') || '',
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
  if (pageName === 'live') {
    return meetingId
      ? `#live?meetingId=${encodeURIComponent(meetingId)}`
      : '#live';
  }
  if (pageName === 'glossary') return '#glossary';
  if (pageName === 'viewer') {
    const viewerQuery = params.get('token')
      ? `token=${encodeURIComponent(params.get('token'))}`
      : params.get('code')
        ? `code=${encodeURIComponent(params.get('code'))}`
        : '';
    return viewerQuery ? `#viewer?${viewerQuery}` : '#viewer';
  }
  if (pageName === 'meeting-settings') {
    return params.toString() ? `#meeting-settings?${params.toString()}` : '#meeting-settings';
  }
  if (pageName === 'meeting-detail' && meetingId) {
    return `#meeting-detail?meetingId=${encodeURIComponent(meetingId)}&from=${encodeURIComponent(params.get('from') || 'meetings')}`;
  }
  return '#meetings';
}
