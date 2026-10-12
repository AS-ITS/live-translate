export function latestOpenMeetingSegment(segments = []) {
  return [...segments]
    .filter((segment) => segment?.id && ['active', 'created'].includes(segment.status))
    .sort((left, right) => (Number(right.sequence) || 0) - (Number(left.sequence) || 0))[0] || null;
}

export async function resumeLegacyMeetingSegment({
  client,
  meetingId,
  nextLiveSessionId,
  finalCues = [],
  cueCheckpoint,
  singleFlight,
  shouldContinue = () => true,
  onSelectedSegment = () => {}
}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!shouldContinue()) return null;
    const { segments } = await client.listSegments({ meetingId });
    const segment = latestOpenMeetingSegment(segments);
    if (!segment) {
      const error = new Error('此會議沒有可繼續的錄音段落，請返回會議管理確認狀態。');
      error.code = 'meeting_segment_invalid_state';
      throw error;
    }
    onSelectedSegment(segment.id);
    if (!shouldContinue()) return null;
    try {
      if (segment.status === 'created' || segment.liveSessionId === null) {
        return await client.startMeeting({ meetingId, segmentId: segment.id, liveSessionId: nextLiveSessionId });
      }
      return await singleFlight.run(`${meetingId}:${segment.id}:recover`, () => client.recoverSegment({
        meetingId,
        segmentId: segment.id,
        idempotencyKey: `recover:${segment.id}:${nextLiveSessionId}`,
        checkpoint: {
          idempotencyKey: `checkpoint:${segment.id}:resume:${nextLiveSessionId}`,
          durableChunks: [],
          pendingPartial: null,
          finalCues: finalCues.filter((item) => item.segmentId === segment.id),
          cueCheckpoint
        },
        nextLiveSessionId,
        failureReason: 'manual_resume',
        failureCategory: 'user_intent',
        outcome: 'interrupted'
      }));
    } catch (error) {
      if (attempt || !['checkpoint_conflict', 'meeting_segment_invalid_state'].includes(error?.code)) throw error;
      const { segments: refreshedSegments } = await client.listSegments({ meetingId });
      if (latestOpenMeetingSegment(refreshedSegments)?.id === segment.id) throw error;
    }
  }
  return null;
}
