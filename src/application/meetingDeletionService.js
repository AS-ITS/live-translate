const ACTIVE_SESSION_STATUSES = new Set(['active', 'paused']);

export function createMeetingDeletionService({
  meetingRepository,
  sessionRepository,
  sessionAudioArtifactRepository,
  deletionRepository,
  deleteMeetingAudio,
  deleteMeetingExports,
  revokeMeetingShares
} = {}) {
  assertMethod(meetingRepository, 'getMeeting', 'meetingRepository');
  assertMethod(meetingRepository, 'listMeetingSegments', 'meetingRepository');
  assertMethod(meetingRepository, 'deleteMeeting', 'meetingRepository');
  assertMethod(sessionRepository, 'listSessionRecords', 'sessionRepository');
  assertMethod(sessionRepository, 'deleteSessionRecord', 'sessionRepository');
  if (deletionRepository) {
    for (const method of ['getTombstone', 'begin', 'finish', 'removeStorageBatch']) {
      assertMethod(deletionRepository, method, 'deletionRepository');
    }
  }
  if (sessionAudioArtifactRepository && typeof sessionAudioArtifactRepository.deleteMany !== 'function') {
    throw new TypeError('sessionAudioArtifactRepository.deleteMany must be a function.');
  }
  if (revokeMeetingShares !== undefined && typeof revokeMeetingShares !== 'function') {
    throw new TypeError('revokeMeetingShares must be a function.');
  }
  if (deleteMeetingAudio !== undefined && typeof deleteMeetingAudio !== 'function') {
    throw new TypeError('deleteMeetingAudio must be a function.');
  }
  if (deleteMeetingExports !== undefined && typeof deleteMeetingExports !== 'function') {
    throw new TypeError('deleteMeetingExports must be a function.');
  }

  return Object.freeze({
    async getDeletionTombstone(meetingId) {
      return deletionRepository?.getTombstone(meetingId) || null;
    },
    async deleteMeeting({ meetingId, actorUserId, actorRole } = {}) {
      const meeting = await meetingRepository.getMeeting(meetingId);
      if (!meeting) {
        const tombstone = await deletionRepository?.getTombstone(meetingId);
        if (tombstone?.state === 'deleted') {
          if (actorUserId !== tombstone.ownerUserId && actorRole !== 'super_admin') {
            throw codedError('auth_forbidden', 'Access is not allowed.');
          }
          return { meeting: null, alreadyDeleted: true, deletedSessionCount: 0, deletedSegmentCount: 0 };
        }
        throw codedError('meeting_not_found', `Meeting not found: ${meetingId}`);
      }

      const segments = await meetingRepository.listMeetingSegments(meetingId);
      const records = (await sessionRepository.listSessionRecords())
        .filter((record) => record?.meetingId === meetingId);

      // A completed meeting is terminal even if an older Session snapshot was not
      // finalized. Keep the child-state guard for meetings that can still record.
      if (meeting.status !== 'completed' && (
        meeting.status === 'active'
        || segments.some((segment) => segment.status === 'active')
        || records.some((record) => ACTIVE_SESSION_STATUSES.has(record.status))
      )) {
        throw codedError('meeting_delete_active_not_allowed', 'Active meetings cannot be deleted.');
      }

      if (deletionRepository) {
        if (!actorUserId) throw codedError('auth_required', 'Authenticated actor required.');
        await deletionRepository.begin({ meetingId, actorUserId });
        const storage = await deletionRepository.removeStorageBatch({
          meetingId,
          ownerUserId: meeting.ownerUserId
        });
        if (!storage.complete) {
          return { meeting, deleting: true, deletedSessionCount: 0, deletedSegmentCount: 0 };
        }
        for (const record of records) {
          await sessionAudioArtifactRepository?.deleteMany?.(record.audioArtifacts);
        }
        await deletionRepository.finish({ meetingId, actorUserId });
      } else {
        await deleteMeetingExports?.(meetingId);
        for (const record of records) {
          await sessionAudioArtifactRepository?.deleteMany?.(record.audioArtifacts);
          await sessionRepository.deleteSessionRecord(record.id);
        }
        await deleteMeetingAudio?.(meetingId);
        await meetingRepository.deleteMeeting(meetingId);
        await revokeMeetingShares?.(meetingId);
      }

      return {
        meeting,
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
