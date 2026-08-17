import { CUE_ERROR_CODES, mergeFinalCue, normalizeCueCheckpoint, validateFinalCue } from '../domain/subtitleCue/index.js';

export function createSubtitleCueRepository({ sessionRepository, meetingRepository } = {}) {
  if (!sessionRepository || !meetingRepository) throw new TypeError('sessionRepository and meetingRepository are required.');

  return Object.freeze({
    async appendFinalCue(cue) {
      const session = await sessionRepository.getSessionRecord(cue?.sessionId);
      if (!session) throw coded(CUE_ERROR_CODES.sessionNotFound, `Session not found: ${cue?.sessionId}`);
      const normalized = validateFinalCue(cue);
      const segment = await meetingRepository.getMeetingSegment(normalized.segmentId);
      if (!segment) throw coded(CUE_ERROR_CODES.segmentNotFound, `Segment not found: ${normalized.segmentId}`);
      if (segment.meetingId !== session.sessionRecord.meetingId || normalized.sessionId !== session.sessionRecord.id) {
        throw coded(CUE_ERROR_CODES.segmentSessionMismatch, `Segment ${normalized.segmentId} does not belong to session ${normalized.sessionId}`);
      }
      const existing = segment.checkpoint?.finalCues || [];
      const merged = mergeFinalCue(existing, normalized);
      if (!merged.appended && !merged.updated) return { cue: merged.cue, appended: false };
      const updated = await meetingRepository.updateMeetingSegment(segment.withCheckpoint({
        ...(segment.checkpoint || {}),
        finalCues: merged.cues,
        updatedAt: Date.now()
      }));
      return { cue: merged.cue, appended: true, segment: updated };
    },

    async updateRefinedCue({ sessionId, cueId, version, inputHash, refinedSource, refinedTranslation, completedAt = new Date().toISOString() } = {}) {
      const session = await sessionRepository.getSessionRecord(sessionId);
      if (!session) throw coded(CUE_ERROR_CODES.sessionNotFound, `Session not found: ${sessionId}`);
      const segments = await meetingRepository.listMeetingSegments(session.sessionRecord.meetingId);
      const segment = segments.find((item) => item.checkpoint?.finalCues?.some((cue) => cue.cueId === cueId));
      const existing = segment?.checkpoint?.finalCues?.find((cue) => cue.cueId === cueId);
      if (!segment || !existing) throw coded(CUE_ERROR_CODES.segmentNotFound, `Cue not found: ${cueId}`);
      if (existing.refinement?.version !== version || existing.refinement?.inputHash !== inputHash) {
        return { applied: false, stale: true, cue: existing };
      }
      const nextCue = validateFinalCue({
        ...existing,
        rawSource: existing.rawSource ?? existing.sourceText,
        rawTranslation: existing.rawTranslation ?? existing.translatedText,
        refinedSource,
        refinedTranslation,
        refinement: {
          ...(existing.refinement || {}),
          status: 'completed',
          completedAt,
          failure: undefined
        }
      });
      const finalCues = segment.checkpoint.finalCues.map((cue) => cue.cueId === cueId ? nextCue : cue);
      const updated = await meetingRepository.updateMeetingSegment(segment.withCheckpoint({
        ...(segment.checkpoint || {}),
        finalCues,
        updatedAt: Date.now()
      }));
      return { applied: true, stale: false, cue: nextCue, segment: updated };
    },

    async listFinalCuesBySession(sessionId) {
      const session = await sessionRepository.getSessionRecord(sessionId);
      if (!session) return [];
      const segments = await meetingRepository.listMeetingSegments(session.sessionRecord.meetingId);
      return segments.flatMap((segment) => segment.checkpoint?.finalCues || [])
        .filter((cue) => cue.status === 'final')
        .sort((left, right) => left.sequence - right.sequence);
    },

    async listFinalCuesByMeeting(meetingId) {
      const segments = await meetingRepository.listMeetingSegments(meetingId);
      return segments.flatMap((segment) => (segment.checkpoint?.finalCues || [])
        .filter((cue) => cue.status === 'final')
        .map((cue) => ({ ...cue, segmentSequence: segment.sequence })))
        .sort((left, right) => left.segmentSequence - right.segmentSequence || left.startTimeMs - right.startTimeMs || left.sequence - right.sequence);
    },

    async listFinalCuesBySegment(segmentId) {
      const segment = await meetingRepository.getMeetingSegment(segmentId);
      return segment?.checkpoint?.finalCues?.filter((cue) => cue.status === 'final').sort((a, b) => a.sequence - b.sequence) || [];
    },

    async saveCueCheckpoint(sessionId, checkpoint) {
      const session = await sessionRepository.getSessionRecord(sessionId);
      if (!session) throw coded(CUE_ERROR_CODES.sessionNotFound, `Session not found: ${sessionId}`);
      const normalized = normalizeCueCheckpoint(checkpoint);
      const segment = await currentSegmentForSession(session, meetingRepository, normalized);
      if (!segment) throw coded(CUE_ERROR_CODES.segmentNotFound, `Active segment not found for session: ${sessionId}`);
      const updated = await meetingRepository.updateMeetingSegment(segment.withCheckpoint({ ...(segment.checkpoint || {}), cueCheckpoint: normalized, updatedAt: Date.now() }));
      return updated.checkpoint.cueCheckpoint;
    },

    async loadCueCheckpoint(sessionId) {
      const session = await sessionRepository.getSessionRecord(sessionId);
      if (!session) return null;
      const segments = await meetingRepository.listMeetingSegments(session.sessionRecord.meetingId);
      return [...segments].reverse().map((segment) => segment.checkpoint?.cueCheckpoint).find(Boolean) || null;
    },

    async clearCueCheckpoint(sessionId) {
      const session = await sessionRepository.getSessionRecord(sessionId);
      if (!session) return false;
      const segments = await meetingRepository.listMeetingSegments(session.sessionRecord.meetingId);
      const segment = [...segments].reverse().find((item) => item.checkpoint?.cueCheckpoint);
      if (!segment || segment.status !== 'active') return false;
      await meetingRepository.updateMeetingSegment(segment.withCheckpoint({ ...(segment.checkpoint || {}), cueCheckpoint: null, updatedAt: Date.now() }));
      return true;
    }
  });
}

async function currentSegmentForSession(session, repository, checkpoint) {
  const segments = await repository.listMeetingSegments(session.sessionRecord.meetingId);
  return segments.find((segment) => segment.id === session.sessionRecord.segmentId && segment.status === 'active') ||
    [...segments].reverse().find((segment) => segment.status === 'active') ||
    [...segments].reverse().find((segment) => segment.checkpoint?.cueCheckpoint === checkpoint);
}

function coded(code, message) { const error = new Error(message); error.code = code; return error; }
