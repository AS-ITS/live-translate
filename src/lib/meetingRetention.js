export function isMeetingContentExpired(meeting, now = Date.now()) {
  if (Number(meeting?.retentionPolicyVersion ?? meeting?.retention_policy_version) !== 2) return false;
  if (meeting?.status !== 'completed') return false;
  const purgeAt = Date.parse(meeting?.purgeAt ?? meeting?.purge_at ?? '');
  return Number.isFinite(purgeAt) && purgeAt <= now;
}

export function meetingContentExpiredError() {
  const error = new Error('Meeting content retention period has expired.');
  error.code = 'meeting_content_expired';
  error.status = 410;
  return error;
}
