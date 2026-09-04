const STORAGE_PREFIX = 'live-translate:meeting-audio:';

export function meetingAudioPreferenceKey(meetingId) {
  return meetingId ? `${STORAGE_PREFIX}${meetingId}` : '';
}

export function getMeetingAudioPreference(meetingId, storage = globalThis.sessionStorage) {
  const key = meetingAudioPreferenceKey(meetingId);
  if (!key || !storage?.getItem) return null;
  try {
    const value = JSON.parse(storage.getItem(key) || 'null');
    return value && typeof value === 'object' ? value : null;
  } catch { return null; }
}

export function setMeetingAudioPreference(meetingId, preference, storage = globalThis.sessionStorage) {
  const key = meetingAudioPreferenceKey(meetingId);
  if (!key || !storage?.setItem) return false;
  try {
    storage.setItem(key, JSON.stringify({
      inputDeviceId: preference?.inputDeviceId || '', outputDeviceId: preference?.outputDeviceId || '',
      inputDeviceLabel: preference?.inputDeviceLabel || '瀏覽器預設麥克風', outputDeviceLabel: preference?.outputDeviceLabel || '瀏覽器預設揚聲器',
      permissionStatus: preference?.permissionStatus || 'confirmed', confirmedAt: preference?.confirmedAt || new Date().toISOString()
    }));
    return true;
  } catch { return false; }
}

export function clearMeetingAudioPreference(meetingId, storage = globalThis.sessionStorage) {
  const key = meetingAudioPreferenceKey(meetingId);
  if (!key || !storage?.removeItem) return;
  try { storage.removeItem(key); } catch { /* unavailable storage */ }
}

export function hasConfirmedMeetingAudioPreference(preference) {
  return preference?.permissionStatus === 'confirmed' && Boolean(preference?.confirmedAt);
}
