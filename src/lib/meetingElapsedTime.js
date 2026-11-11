export function meetingElapsedMs(startedAt, now = Date.now()) {
  const startedAtMs = timestampMs(startedAt);
  const nowMs = timestampMs(now);
  if (startedAtMs === null || nowMs === null) return null;
  return Math.max(0, nowMs - startedAtMs);
}

const VISIBLE_MEETING_TIMER_STATUSES = new Set([
  'requesting-permission', 'connecting', 'listening', 'paused', 'stopping',
  'reconnecting', 'switching-segment', 'provider-recovery', 'provider-recovery-failed'
]);

export function shouldShowMeetingElapsedTimer(status, startedAt) {
  return meetingElapsedMs(startedAt, startedAt) !== null && VISIBLE_MEETING_TIMER_STATUSES.has(status);
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
