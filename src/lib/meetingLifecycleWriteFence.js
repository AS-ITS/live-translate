let activeFence = null;

export function setMeetingLifecycleWriteFence(value) {
  activeFence = value ? { ...value } : null;
}

export function clearMeetingLifecycleWriteFence(meetingId = null) {
  if (!meetingId || activeFence?.meetingId === meetingId) activeFence = null;
}

export function meetingLifecycleWriteHeaders(meetingId, segmentId = null) {
  if (!activeFence || activeFence.meetingId !== meetingId) return {};
  const resolvedSegmentId = segmentId || activeFence.segmentId;
  if (!resolvedSegmentId || resolvedSegmentId !== activeFence.segmentId) return {};
  return {
    'x-meeting-session-id': activeFence.sessionId,
    'x-meeting-segment-id': activeFence.segmentId,
    'x-meeting-lease-id': activeFence.leaseId,
    'x-meeting-fence-token': String(activeFence.fenceToken)
  };
}
