import { CUE_ERROR_CODES, mergeFinalCue, normalizeCueCheckpoint, validateFinalCue } from '../domain/subtitleCue/index.js';
import { allocateSubtitleResegmentedCueTimes, stableSubtitleGroup, subtitleResegmentationInputHash } from '../lib/subtitleResegmentation.js';

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
      const result = await this.applyRefinementResults({
        sessionId,
        results: [{ cueId, targetCueId: cueId, version, inputHash, refinedSource, refinedTranslation, fields: ['source', 'translation'] }],
        completedAt
      });
      const item = result.results[0];
      if (item?.reason === 'target_not_found') throw coded(CUE_ERROR_CODES.segmentNotFound, `Cue not found: ${cueId}`);
      return { applied: item?.applied === true, stale: item?.stale === true, cue: item?.cue, segment: result.segment };
    },

    async applyRefinementResults({ sessionId, refinementJobId, requestId, connectionEpoch, results = [], completedAt = new Date().toISOString(), logger = defaultDiagnosticLogger } = {}) {
      const session = await sessionRepository.getSessionRecord(sessionId);
      if (!session) throw coded(CUE_ERROR_CODES.sessionNotFound, `Session not found: ${sessionId}`);
      const segments = await meetingRepository.listMeetingSegments(session.sessionRecord.meetingId);
      const normalizedResults = Array.isArray(results) ? results : [];
      const outcomes = [];
      const changedSegments = new Map();
      for (const result of normalizedResults) {
        const targetCueId = result?.targetCueId;
        const found = segments.flatMap((segment) => (segment.checkpoint?.finalCues || []).map((cue) => ({ segment, cue })))
          .find(({ cue }) => cue.cueId === targetCueId);
        if (!found) {
          const diagnostic = { event: 'refinement_target_not_found', targetCueId, availableCueIds: segments.flatMap((segment) => segment.checkpoint?.finalCues || []).map((cue) => cue.cueId), sessionId, segmentId: result?.segmentId ?? null, connectionEpoch: connectionEpoch ?? null, refinementJobId: refinementJobId ?? null, requestId: requestId ?? null };
          logger(diagnostic);
          outcomes.push({ applied: false, reason: 'target_not_found', targetCueId });
          continue;
        }
        const { segment, cue: existing } = found;
        const targetSegmentId = result.segmentId || existing.segmentId;
        if (targetSegmentId !== existing.segmentId || (result.sessionId && result.sessionId !== existing.sessionId) ||
          (result.sequence !== undefined && result.sequence !== existing.sequence) ||
          (existing.refinement?.version !== undefined && result.version !== undefined && result.version < existing.refinement.version) ||
          (existing.refinement?.version !== undefined && result.version !== undefined && result.version === existing.refinement.version &&
            existing.refinement?.inputHash !== undefined && result.inputHash !== undefined && existing.refinement.inputHash !== result.inputHash) ||
          (existing.refinement?.version !== undefined && result.version !== undefined && result.version === existing.refinement.version &&
            existing.refinement?.executionId && refinementJobId && existing.refinement.executionId !== refinementJobId)) {
          outcomes.push({ applied: false, stale: true, targetCueId, cue: existing });
          continue;
        }
        const fields = Array.isArray(result.fields) ? result.fields : ['source', 'translation'];
        const nextCue = validateFinalCue({
          ...existing,
          rawSource: existing.rawSource ?? existing.sourceText,
          rawTranslation: existing.rawTranslation ?? existing.translatedText,
          refinedSource: fields.includes('source') ? result.refinedSource ?? existing.refinedSource : existing.refinedSource,
          refinedTranslation: fields.includes('translation') ? (result.refinedTranslation ?? result.polishedText ?? existing.refinedTranslation) : existing.refinedTranslation,
          refinement: {
            ...(existing.refinement || {}),
            status: 'completed',
            version: result.version ?? existing.refinement?.version ?? 1,
            ...(result.refinementJobId || refinementJobId ? { executionId: result.refinementJobId || refinementJobId } : {}),
            completedAt,
            failure: undefined
          }
        });
        const current = changedSegments.get(segment.id) || segment.checkpoint?.finalCues || [];
        changedSegments.set(segment.id, current.map((candidate) => candidate.cueId === existing.cueId ? nextCue : candidate));
        outcomes.push({ applied: true, stale: false, targetCueId, cue: nextCue });
      }
      let updatedSegment;
      for (const [segmentId, finalCues] of changedSegments) {
        const segment = segments.find((candidate) => candidate.id === segmentId);
        updatedSegment = await meetingRepository.updateMeetingSegment(segment.withCheckpoint({ ...(segment.checkpoint || {}), finalCues, updatedAt: Date.now() }));
      }
      return { applied: outcomes.some((item) => item.applied), results: outcomes, segment: updatedSegment };
    },

    async saveRefinedSubtitleCues({ sessionId, sourceCueIds = [], refinedCues = [], inputHash, completedAt = new Date().toISOString() } = {}) {
      const session = await sessionRepository.getSessionRecord(sessionId);
      if (!session) throw coded(CUE_ERROR_CODES.sessionNotFound, `Session not found: ${sessionId}`);
      const segments = await meetingRepository.listMeetingSegments(session.sessionRecord.meetingId);
      const raw = segments.flatMap((segment) => segment.checkpoint?.finalCues || [])
        .filter((cue) => sourceCueIds.includes(cue.cueId));
      const group = stableSubtitleGroup(raw);
      const hash = inputHash || subtitleResegmentationInputHash(group);
      if (group.length === 0 || hash !== subtitleResegmentationInputHash(group)) return { applied: false, stale: true };
      const refinedSubtitleCues = allocateSubtitleResegmentedCueTimes(group, refinedCues, { groupHash: hash });
      const segment = segments.find((item) => group.some((cue) => cue.segmentId === item.id));
      if (!segment) throw coded(CUE_ERROR_CODES.segmentNotFound, `Cue group not found for session: ${sessionId}`);
      const updated = await meetingRepository.updateMeetingSegment(segment.withCheckpoint({
        ...(segment.checkpoint || {}),
        refinedSubtitleCues,
        refinedSubtitleRevision: (segment.checkpoint?.refinedSubtitleRevision || 0) + 1,
        refinedSubtitleInputHash: hash,
        refinedSubtitleStatus: 'completed',
        refinedSubtitleCompletedAt: completedAt,
        updatedAt: Date.now()
      }));
      return { applied: true, refinedSubtitleCues, segment: updated };
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

    async listRefinedSubtitleCuesBySession(sessionId) {
      const session = await sessionRepository.getSessionRecord(sessionId);
      if (!session) return [];
      const segments = await meetingRepository.listMeetingSegments(session.sessionRecord.meetingId);
      return segments.flatMap((segment) => segment.checkpoint?.refinedSubtitleCues || [])
        .filter((cue) => cue.status === 'final')
        .sort((a, b) => a.startTimeMs - b.startTimeMs || a.sequence - b.sequence);
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
function defaultDiagnosticLogger(event) { if (process.env.NODE_ENV !== 'production') console.warn(JSON.stringify(event)); }
