const ACTIVE_SESSION_STATUSES = new Set(['active', 'paused']);

export function createMeetingDeletionService({
  meetingRepository,
  sessionRepository,
  sessionAudioArtifactRepository,
  revokeMeetingShares
} = {}) {
  assertMethod(meetingRepository, 'getMeeting', 'meetingRepository');
  assertMethod(meetingRepository, 'listMeetingSegments', 'meetingRepository');
  assertMethod(meetingRepository, 'deleteMeeting', 'meetingRepository');
  assertMethod(sessionRepository, 'listSessionRecords', 'sessionRepository');
  assertMethod(sessionRepository, 'deleteSessionRecord', 'sessionRepository');
  if (sessionAudioArtifactRepository && typeof sessionAudioArtifactRepository.deleteMany !== 'function') {
    throw new TypeError('sessionAudioArtifactRepository.deleteMany must be a function.');
  }
  if (revokeMeetingShares !== undefined && typeof revokeMeetingShares !== 'function') {
    throw new TypeError('revokeMeetingShares must be a function.');
  }

  return Object.freeze({
    async deleteMeeting({ meetingId } = {}) {
      const meeting = await meetingRepository.getMeeting(meetingId);
      if (!meeting) {
        throw codedError('meeting_not_found', `Meeting not found: ${meetingId}`);
      }

      const segments = await meetingRepository.listMeetingSegments(meetingId);
      const records = (await sessionRepository.listSessionRecords())
        .filter((record) => record?.meetingId === meetingId);

      if (meeting.status === 'active' || segments.some((segment) => segment.status === 'active') || records.some((record) => ACTIVE_SESSION_STATUSES.has(record.status))) {
        throw codedError('meeting_delete_active_not_allowed', 'Active meetings cannot be deleted.');
      }

      for (const record of records) {
        await sessionAudioArtifactRepository?.deleteMany?.(record.audioArtifacts);
        await sessionRepository.deleteSessionRecord(record.id);
      }

      const deletedMeeting = await meetingRepository.deleteMeeting(meetingId);
      await revokeMeetingShares?.(meetingId);

      return {
        meeting: deletedMeeting,
        deletedSessionCount: records.length,
        deletedSegmentCount: segments.length
      };
    }
  });
}

function assertMethod(target, methodName, owner) {
  if (!target || typeof target[methodName] !== 'function') {
    throw new TypeError(`${owner}.${methodName} must be a function.`);
  }
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
