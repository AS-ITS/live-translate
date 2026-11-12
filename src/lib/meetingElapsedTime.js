export function meetingElapsedMs(startedAt, now = Date.now()) {
  const startedAtMs = timestampMs(startedAt);
  const nowMs = timestampMs(now);
  if (startedAtMs === null || nowMs === null) return null;
  return Math.max(0, nowMs - startedAtMs);
}

const timerKey = (meetingId) => `live-translate:meeting-timer:${meetingId}`;

export function readMeetingTimerStart(meetingId) {
  if (!meetingId) return null;
  try {
    const value = JSON.parse(globalThis.sessionStorage.getItem(timerKey(meetingId)));
    return value?.meetingId === meetingId && Number.isFinite(value.startedAt)
      ? value.startedAt : null;
  } catch {
    return null;
  }
}

export function startMeetingTimer(meetingId, now = Date.now()) {
  if (!meetingId || !Number.isFinite(now)) return null;
  const existing = readMeetingTimerStart(meetingId);
  if (existing !== null) return existing;
  try {
    globalThis.sessionStorage.setItem(timerKey(meetingId), JSON.stringify({ meetingId, startedAt: now }));
    return now;
  } catch {
    return null;
  }
}

export function clearMeetingTimer(meetingId) {
  if (!meetingId) return;
  try {
    globalThis.sessionStorage.removeItem(timerKey(meetingId));
  } catch {
    // The timer is optional UI state.
  }
}

export function formatMeetingElapsed(elapsedMs) {
  if (!Number.isFinite(elapsedMs)) return '00:00:00';
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
}

function timestampMs(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
