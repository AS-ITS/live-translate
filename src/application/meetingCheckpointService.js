import { Meeting, MeetingSegment, isTerminalMeetingSegmentStatus } from '../domain/meeting/index.js';
import { mergeFinalCue, normalizeCueCheckpoint, validateFinalCue } from '../domain/subtitleCue/index.js';
import { normalizeMeetingGlossaryAliases } from '../lib/meetingGlossary.js';
import { checkCheckpointOperation, checkpointConflict, checkpointOperationKey, recordCheckpointOperation } from '../lib/checkpointOperation.js';

const STREAM_ORDER = Object.freeze({ source: 0, translation: 1 });
const MEETING_RETENTION_MS = 30 * 60 * 1000;

export function createMeetingCheckpointService({
  meetingRepository,
  sessionRepository,
  idGenerator = defaultIdGenerator,
  clock = () => Date.now(),
  onSegmentFinalized
} = {}) {
  assertMeetingRepository(meetingRepository);
  if (typeof idGenerator !== 'function') throw new TypeError('idGenerator is required.');
  if (typeof clock !== 'function') throw new TypeError('clock is required.');

  async function commitLifecycleCheckpoint({ segment, incoming, operationKey, details, now, transition }) {
    const operationInput = { ...incoming, idempotencyKey: operationKey, lifecycle: details };
    const apply = (current) => {
      if (current.meetingId !== segment.meetingId || current.status !== 'active') {
        throw checkpointConflict('segment changed before checkpoint transition');
      }
      const operation = checkCheckpointOperation(current.checkpoint, operationInput);
      if (operation.duplicate) throw checkpointConflict('checkpoint transition already applied');
      const merged = mergeCheckpoint({
        existing: current.checkpoint, incoming,
        meetingId: current.meetingId, segmentId: current.id,
        sessionRepository, updatedAt: now
      });
      const checkpoint = recordCheckpointOperation(current.checkpoint, operationInput,
        { ...merged, idempotencyKey: operationKey }, operation.canonical);
      return transition(current, checkpoint);
    };
    if (typeof meetingRepository.mutateMeetingSegment === 'function') {
      return meetingRepository.mutateMeetingSegment(segment.id, apply);
    }
    if (typeof meetingRepository.commitCheckpoint === 'function') {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const current = attempt === 0 ? segment : await requireSegment({
          meetingRepository, meetingId: segment.meetingId, segmentId: segment.id
        });
        const next = apply(current);
        try {
          return await meetingRepository.commitCheckpoint({ current, next, incoming: operationInput });
        } catch (error) {
          if (error?.code !== 'checkpoint_revision_conflict' || attempt === 3) throw error;
        }
      }
    }
    throw codedError('meeting_checkpoint_unavailable', 'checkpoint storage does not support atomic mutation');
  }

  return Object.freeze({
    async createMeeting({
      liveSessionId = null,
      glossaryEntries = [],
      name = null,
      sourceLanguageCode = null,
      targetLanguageCode = null,
      echoTargetLanguage = true,
      shouldRecordInputAudio = false,
      privateGlossaryEntries = [],
      draft = false,
      lifecycleContractVersion = 1
    } = {}) {
      const now = clock();
      const meetingId = idGenerator('meeting');
      if (lifecycleContractVersion === 2) {
        const meeting = new Meeting({
          id: meetingId,
          createdAt: now,
          updatedAt: now,
          status: 'created',
          startedAt: null,
          lifecycleContractVersion: 2,
          lifecycleVersion: 0,
          glossaryEntries,
          name,
          sourceLanguageCode,
          targetLanguageCode,
          echoTargetLanguage,
          shouldRecordInputAudio,
          privateGlossaryEntries
        });
        if (typeof meetingRepository.createMeetingWithInitialSegment === 'function') {
          return meetingRepository.createMeetingWithInitialSegment({ meeting, segment: null });
        }
        return { meeting: await meetingRepository.createMeeting(meeting), segment: null };
      }
      const segmentId = idGenerator('segment');
      if (typeof meetingRepository.createMeetingWithInitialSegment === 'function') {
        const initialMeeting = new Meeting({
          id: meetingId,
          createdAt: now,
          updatedAt: now,
          status: draft ? 'created' : 'active',
          startedAt: draft ? null : now,
          glossaryEntries,
          name,
          sourceLanguageCode,
          targetLanguageCode,
          echoTargetLanguage,
          shouldRecordInputAudio,
          privateGlossaryEntries
        });
        const initialSegment = new MeetingSegment({
          id: segmentId,
          meetingId,
          sequence: 0,
          status: draft ? 'created' : 'active',
          startedAt: draft ? null : now,
          liveSessionId: liveSessionId === null ? null : validateRequiredString(liveSessionId, 'liveSessionId'),
          settingsSnapshot: meetingSettingsSnapshot(initialMeeting),
          createdAt: now,
          updatedAt: now
        });
        return meetingRepository.createMeetingWithInitialSegment({ meeting: initialMeeting, segment: initialSegment });
      }
      const meeting = await meetingRepository.createMeeting({
        id: meetingId,
        createdAt: now,
        glossaryEntries,
        name,
        sourceLanguageCode,
        targetLanguageCode,
        echoTargetLanguage,
        shouldRecordInputAudio,
        privateGlossaryEntries
      });
      const activeMeeting = draft
        ? meeting
        : await meetingRepository.updateMeeting(meeting.activate(now));
      const segment = await meetingRepository.createMeetingSegment({
        id: segmentId,
        meetingId: activeMeeting.id,
        sequence: 0,
        liveSessionId: liveSessionId === null ? null : validateRequiredString(liveSessionId, 'liveSessionId'),
        settingsSnapshot: meetingSettingsSnapshot(activeMeeting),
        createdAt: now
      });
      const activeSegment = draft
        ? segment
        : await meetingRepository.updateMeetingSegment(segment.activate(now));

      return { meeting: activeMeeting, segment: activeSegment };
    },

    async updateMeeting({ meetingId, settings = {} } = {}) {
      const normalizedMeetingId = validateRequiredString(meetingId, 'meetingId');
      const meeting = await meetingRepository.getMeeting(normalizedMeetingId);
      if (!meeting) throw codedError('meeting_not_found', `Meeting not found: ${normalizedMeetingId}`);
      if (meeting.status === 'completed') {
        throw codedError('meeting_settings_locked', 'Completed meeting settings cannot be changed.');
      }
      const now = clock();
      const updated = await meetingRepository.updateMeeting(meeting.withSettings({
        ...settings,
        updatedAt: now
      }));
      return { meeting: updated };
    },

    async deleteMeeting({ meetingId } = {}) {
      const normalizedMeetingId = validateRequiredString(meetingId, 'meetingId');
      const meeting = await meetingRepository.getMeeting(normalizedMeetingId);
      if (!meeting) throw codedError('meeting_not_found', `Meeting not found: ${normalizedMeetingId}`);
      if (meeting.status !== 'created') {
        throw codedError('meeting_delete_not_allowed', 'Only meetings that have not started can be deleted.');
      }
      if (typeof meetingRepository.deleteMeeting !== 'function') {
        throw codedError('meeting_checkpoint_unavailable', 'Meeting deletion is not configured.');
      }

      const deleted = await meetingRepository.deleteMeeting(normalizedMeetingId);
      return { meeting: deleted };
    },

    async completeMeeting({ meetingId } = {}) {
      const normalizedMeetingId = validateRequiredString(meetingId, 'meetingId');
      const meeting = await meetingRepository.getMeeting(normalizedMeetingId);
      if (!meeting) throw codedError('meeting_not_found', `Meeting not found: ${normalizedMeetingId}`);
      if (meeting.status === 'completed') return { meeting };
      if (meeting.status === 'failed') {
        throw codedError('meeting_complete_not_allowed', 'Failed meetings cannot be completed.');
      }

      const segments = await meetingRepository.listMeetingSegments(normalizedMeetingId);
      const now = clock();
      for (const segment of segments.filter((item) => ['active', 'created'].includes(item.status))) {
        await meetingRepository.updateMeetingSegment(segment.complete({
          endedAt: now,
          liveSessionId: segment.status === 'created' ? null : segment.liveSessionId
        }));
      }

      const purgeAt = meeting.purgeAt ?? new Date(new Date(now).getTime() + MEETING_RETENTION_MS).toISOString();
      const completedMeeting = await meetingRepository.updateMeeting(meeting.complete(now, purgeAt));
      return { meeting: completedMeeting };
    },

    async startMeeting({ meetingId, segmentId, liveSessionId } = {}) {
      const meeting = await meetingRepository.getMeeting(validateRequiredString(meetingId, 'meetingId'));
      if (!meeting) throw codedError('meeting_not_found', `Meeting not found: ${meetingId}`);
      const segment = await requireSegment({ meetingRepository, meetingId, segmentId });
      if (!['created', 'active'].includes(segment.status) || segment.liveSessionId !== null) {
        throw codedError('meeting_segment_invalid_state', 'segment is not available to start');
      }
      const now = clock();
      const activeMeeting = ['created', 'interrupted'].includes(meeting.status)
        ? await meetingRepository.updateMeeting(meeting.activate(now))
        : meeting;
      const withLiveSession = segment.withLiveSession(validateRequiredString(liveSessionId, 'liveSessionId'));
      const activeSegment = segment.status === 'created'
        ? await meetingRepository.updateMeetingSegment(withLiveSession.transitionTo('active', {
          startedAt: now,
          endedAt: null,
          errorInfo: null,
          settingsSnapshot: meetingSettingsSnapshot(activeMeeting)
        }))
        : await meetingRepository.updateMeetingSegment(withLiveSession);
      return { meeting: activeMeeting, segment: activeSegment };
    },

    async listMeetingSegments(meetingId) {
      const normalizedMeetingId = validateRequiredString(meetingId, 'meetingId');
      const meeting = await meetingRepository.getMeeting(normalizedMeetingId);
      if (!meeting) throw codedError('meeting_not_found', `Meeting not found: ${normalizedMeetingId}`);
      return meetingRepository.listMeetingSegments(normalizedMeetingId);
    },

    async attachLiveSession({ meetingId, segmentId, liveSessionId } = {}) {
      const segment = await requireSegment({ meetingRepository, meetingId, segmentId });
      if (segment.status !== 'active' || segment.liveSessionId !== null) {
        throw codedError('meeting_segment_invalid_state', 'segment is not available for a live session');
      }
      const updated = await meetingRepository.updateMeetingSegment(
        segment.withLiveSession(validateRequiredString(liveSessionId, 'liveSessionId'))
      );
      return { meetingId: updated.meetingId, segmentId: updated.id, segment: updated };
    },

    async getCheckpoint({ meetingId, segmentId } = {}) {
      const segment = await requireSegment({ meetingRepository, meetingId, segmentId });
      return {
        meetingId: segment.meetingId,
        segmentId: segment.id,
      checkpoint: segment.checkpoint === null || segment.checkpoint === undefined
        ? null
        : normalizeStoredCheckpoint(segment.checkpoint, segment.meetingId, segment.id)
      };
    },

    async updateCheckpoint({ meetingId, segmentId, checkpoint, protocol = 'v2' } = {}) {
      const segment = await requireSegment({ meetingRepository, meetingId, segmentId });
      const now = clock();
      const incoming = validateCheckpointInput(checkpoint, segment.meetingId, segment.id);
      if (protocol === 'legacy') {
        incoming.idempotencyKey = checkpointOperationKey(segment.id, incoming);
      } else if (protocol !== 'v2') {
        throw codedError('invalid_request', 'Unsupported checkpoint protocol.');
      }
      await validateCueIntegrity(incoming.finalCues, meetingRepository, sessionRepository, segment.meetingId);
      const apply = (current) => {
        if (current.meetingId !== segment.meetingId) throw checkpointConflict('checkpoint owner changed');
        if (isTerminalMeetingSegmentStatus(current.status)) {
          throw codedError('meeting_segment_invalid_state', `checkpoint cannot be changed for ${current.status} segment`);
        }
        const operation = checkCheckpointOperation(current.checkpoint, incoming);
        if (operation.duplicate) return current;
        const nextCheckpoint = mergeCheckpoint({
          existing: current.checkpoint,
          incoming,
          meetingId: current.meetingId,
          segmentId: current.id,
          sessionRepository,
          updatedAt: now
        });
        return current.withCheckpoint(recordCheckpointOperation(
          current.checkpoint, incoming, nextCheckpoint, operation.canonical
        ), now);
      };
      let updated;
      if (typeof meetingRepository.mutateMeetingSegment === 'function') {
        updated = await meetingRepository.mutateMeetingSegment(segment.id, apply);
      } else if (typeof meetingRepository.commitCheckpoint === 'function') {
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const current = attempt === 0 ? segment : await requireSegment({ meetingRepository, meetingId, segmentId });
          const next = apply(current);
          if (next === current) { updated = current; break; }
          try {
            updated = await meetingRepository.commitCheckpoint({ current, next, incoming });
            break;
          } catch (error) {
            if (error?.code !== 'checkpoint_revision_conflict' || attempt === 3) throw error;
          }
        }
      } else {
        throw codedError('meeting_checkpoint_unavailable', 'checkpoint storage does not support atomic mutation');
      }
      return {
        meetingId: updated.meetingId,
        segmentId: updated.id,
        checkpoint: updated.checkpoint
      };
    },

    async rolloverSegment({ meetingId, segmentId, rollover, recorderSessionId = null } = {}) {
      const currentSegment = await requireSegment({ meetingRepository, meetingId, segmentId });
      const input = validateRolloverInput(rollover);
      if (typeof meetingRepository.atomicRolloverSegment === 'function') {
        if (currentSegment.lifecycleContractVersion !== 1) {
          throw codedError('meeting_lifecycle_conflict', 'Legacy rollover requires lifecycle contract v1.');
        }
        const incoming = validateCheckpointInput(input.checkpoint, currentSegment.meetingId, currentSegment.id);
        await validateCueIntegrity(incoming.finalCues, meetingRepository, sessionRepository, currentSegment.meetingId);
        const operationInput = {
          ...incoming,
          idempotencyKey: input.idempotencyKey,
          lifecycle: { kind: 'rollover', nextLiveSessionId: input.nextLiveSessionId }
        };
        const operation = checkCheckpointOperation(currentSegment.checkpoint, operationInput);
        const now = clock();
        let completedSegment = currentSegment;
        if (currentSegment.status === 'active' && !operation.duplicate) {
          const merged = mergeCheckpoint({
            existing: currentSegment.checkpoint,
            incoming,
            meetingId: currentSegment.meetingId,
            segmentId: currentSegment.id,
            sessionRepository,
            updatedAt: now
          });
          const checkpoint = recordCheckpointOperation(currentSegment.checkpoint, operationInput,
            { ...merged, idempotencyKey: input.idempotencyKey }, operation.canonical);
          completedSegment = currentSegment.complete({ endedAt: now, checkpoint });
        } else if (currentSegment.status !== 'completed' || !operation.duplicate) {
          throw codedError('meeting_segment_invalid_state', 'Rollover requires an active Segment or an exact committed replay.');
        }
        const result = await meetingRepository.atomicRolloverSegment({
          current: currentSegment,
          completed: completedSegment,
          incoming: operationInput,
          recorderSessionId,
          nextLiveSessionId: input.nextLiveSessionId,
          settingsSnapshot: meetingSettingsSnapshot(await meetingRepository.getMeeting(currentSegment.meetingId))
        });
        if (!result.replayed) await notifySegmentFinalized(onSegmentFinalized, result.completedSegment);
        return { completedSegment: result.completedSegment, segment: result.segment };
      }
      const existingSegments = await meetingRepository.listMeetingSegments(currentSegment.meetingId);
      const existingNext = existingSegments.find((segment) => segment.sequence === currentSegment.sequence + 1);
      const storedCheckpoint = normalizeStoredCheckpoint(currentSegment.checkpoint, currentSegment.meetingId, currentSegment.id);
      let boundSessionId = recorderSessionId || currentSegment.sessionId;
      if (!boundSessionId && typeof sessionRepository?.listSessionRecords === 'function') {
        const records = await sessionRepository.listSessionRecords();
        const candidates = records.filter((record) => record.meetingId === currentSegment.meetingId
          && record.segmentId === currentSegment.id && record.status === 'active'
          && Number(record.lifecycleContractVersion ?? 1) === 1);
        if (candidates.length > 1) {
          throw codedError('recorder_session_mismatch', 'Rollover source Segment has ambiguous active Sessions.');
        }
        boundSessionId = candidates[0]?.id || null;
      }
      if (boundSessionId) {
        const existingSession = await sessionRepository?.getSessionRecord?.(boundSessionId);
        const record = existingSession?.sessionRecord;
        if (!record || record.meetingId !== currentSegment.meetingId
          || Number(record.lifecycleContractVersion ?? 1) !== 1
          || (record.segmentId !== currentSegment.id && currentSegment.sessionId !== boundSessionId)
          || (currentSegment.sessionId && currentSegment.sessionId !== boundSessionId)) {
          throw codedError('recorder_session_mismatch', 'Recorder Session does not match rollover source Segment.');
        }
      }
      if (
        existingNext &&
        currentSegment.status === 'completed' &&
        storedCheckpoint.idempotencyKey === input.idempotencyKey &&
        existingNext.liveSessionId === input.nextLiveSessionId
      ) {
        if (boundSessionId && existingNext.sessionId !== boundSessionId) {
          throw codedError('recorder_session_mismatch', 'Rollover successor is not bound to this Recorder Session.');
        }
        return { completedSegment: currentSegment, segment: existingNext };
      }

      if (existingNext) {
        throw codedError('checkpoint_conflict', `segment rollover conflict: ${input.idempotencyKey}`);
      }

      if (currentSegment.status !== 'active') {
        throw codedError('meeting_segment_invalid_state', `segment rollover requires an active segment, got ${currentSegment.status}`);
      }

      const now = clock();
      const incoming = validateCheckpointInput(input.checkpoint, currentSegment.meetingId, currentSegment.id);
      await validateCueIntegrity(incoming.finalCues, meetingRepository, sessionRepository, currentSegment.meetingId);
      const completedSegment = await commitLifecycleCheckpoint({
        segment: currentSegment, incoming, operationKey: input.idempotencyKey,
        details: { kind: 'rollover', nextLiveSessionId: input.nextLiveSessionId }, now,
        transition: (current, checkpoint) => (boundSessionId
          ? new MeetingSegment({ ...current, sessionId: boundSessionId })
          : current).complete({ endedAt: now, checkpoint })
      });
      const nextSegment = await meetingRepository.createMeetingSegment({
        id: idGenerator('segment'),
        meetingId: currentSegment.meetingId,
        sessionId: boundSessionId,
        sequence: currentSegment.sequence + 1,
        liveSessionId: input.nextLiveSessionId,
        settingsSnapshot: meetingSettingsSnapshot(await meetingRepository.getMeeting(currentSegment.meetingId)),
        createdAt: now
      });
      const activeNextSegment = await meetingRepository.updateMeetingSegment(nextSegment.activate(now));
      await notifySegmentFinalized(onSegmentFinalized, completedSegment);

      return { completedSegment, segment: activeNextSegment };
    },

    async recoverSegment({ meetingId, segmentId, recovery } = {}) {
      const currentSegment = await requireSegment({ meetingRepository, meetingId, segmentId });
      const input = validateRecoveryInput(recovery);
      const existingSegments = await meetingRepository.listMeetingSegments(currentSegment.meetingId);
      const existingNext = existingSegments.find((segment) => segment.sequence === currentSegment.sequence + 1);
      const storedCheckpoint = normalizeStoredCheckpoint(currentSegment.checkpoint, currentSegment.meetingId, currentSegment.id);
      const errorInfo = {
        reason: input.failureReason,
        category: input.failureCategory
      };

      if (input.outcome === 'interrupted') {
        if (
          existingNext &&
          currentSegment.status === 'interrupted' &&
          storedCheckpoint.idempotencyKey === input.idempotencyKey &&
          existingNext.liveSessionId === (input.nextLiveSessionId || null) &&
          sameErrorInfo(currentSegment.errorInfo, errorInfo)
        ) {
          return { interruptedSegment: currentSegment, segment: existingNext };
        }

        if (existingNext) {
          throw codedError('checkpoint_conflict', `segment recovery conflict: ${input.idempotencyKey}`);
        }
      } else if (
        currentSegment.status === 'failed' &&
        storedCheckpoint.idempotencyKey === input.idempotencyKey &&
        sameErrorInfo(currentSegment.errorInfo, errorInfo)
      ) {
        if (existingNext) {
          throw codedError('checkpoint_conflict', `segment recovery conflict: ${input.idempotencyKey}`);
        }
        return { failedSegment: currentSegment };
      }

      if (currentSegment.status !== 'active') {
        throw codedError('meeting_segment_invalid_state', `segment recovery requires an active segment, got ${currentSegment.status}`);
      }

      const now = clock();
      const incoming = validateCheckpointInput(input.checkpoint, currentSegment.meetingId, currentSegment.id);
      await validateCueIntegrity(incoming.finalCues, meetingRepository, sessionRepository, currentSegment.meetingId);
      const details = {
        kind: 'recovery', outcome: input.outcome, nextLiveSessionId: input.nextLiveSessionId,
        failureReason: input.failureReason, failureCategory: input.failureCategory
      };

      if (input.outcome === 'failed') {
        const failedSegment = await commitLifecycleCheckpoint({
          segment: currentSegment, incoming, operationKey: input.idempotencyKey, details, now,
          transition: (current, checkpoint) => current.fail({ endedAt: now, checkpoint, errorInfo })
        });
        await notifySegmentFinalized(onSegmentFinalized, failedSegment);
        return { failedSegment };
      }

      const interruptedSegment = await commitLifecycleCheckpoint({
        segment: currentSegment, incoming, operationKey: input.idempotencyKey, details, now,
        transition: (current, checkpoint) => current.interrupt({ endedAt: now, checkpoint, errorInfo })
      });
      if (!input.nextLiveSessionId) {
        const meeting = await meetingRepository.getMeeting(currentSegment.meetingId);
        if (!meeting) throw codedError('meeting_not_found', `Meeting not found: ${currentSegment.meetingId}`);
        const interruptedMeeting = meeting.status === 'active'
          ? await meetingRepository.updateMeeting(meeting.interrupt(now))
          : meeting;
        const nextSegment = await meetingRepository.createMeetingSegment({
          id: idGenerator('segment'),
          meetingId: currentSegment.meetingId,
          sequence: currentSegment.sequence + 1,
          liveSessionId: null,
          settingsSnapshot: meetingSettingsSnapshot(interruptedMeeting),
          createdAt: now
        });
        await notifySegmentFinalized(onSegmentFinalized, interruptedSegment);
        return { interruptedSegment, segment: nextSegment, meeting: interruptedMeeting };
      }
      const nextSegment = await meetingRepository.createMeetingSegment({
        id: idGenerator('segment'),
        meetingId: currentSegment.meetingId,
        sequence: currentSegment.sequence + 1,
        liveSessionId: input.nextLiveSessionId,
        settingsSnapshot: meetingSettingsSnapshot(await meetingRepository.getMeeting(currentSegment.meetingId)),
        createdAt: now
      });
      const activeNextSegment = await meetingRepository.updateMeetingSegment(nextSegment.activate(now));
      await notifySegmentFinalized(onSegmentFinalized, interruptedSegment);

      return { interruptedSegment, segment: activeNextSegment };
    }
  });
}

export function meetingSettingsSnapshot(meeting) {
  return meeting ? {
    name: meeting.name,
    sourceLanguageCode: meeting.sourceLanguageCode,
    targetLanguageCode: meeting.targetLanguageCode,
    echoTargetLanguage: meeting.echoTargetLanguage,
    shouldRecordInputAudio: meeting.shouldRecordInputAudio,
    glossaryEntries: Array.isArray(meeting.glossaryEntries)
      ? meeting.glossaryEntries.map((entry) => ({
        ...entry,
        replacementAliases: normalizeMeetingGlossaryAliases(entry?.replacementAliases)
      }))
      : [],
    privateGlossaryEntries: Array.isArray(meeting.privateGlossaryEntries)
      ? meeting.privateGlossaryEntries.map((entry) => ({
        source: entry.source,
        translations: { ...entry.translations },
        replacementAliases: Object.fromEntries(Object.entries(entry.replacementAliases || {}).map(([languageCode, aliases]) => [languageCode, normalizeMeetingGlossaryAliases(aliases)]))
      }))
      : []
  } : null;
}

async function notifySegmentFinalized(callback, segment) {
  if (typeof callback !== 'function') return;
  const sessionId = segment?.checkpoint?.finalCues?.find((cue) => cue.sessionId)?.sessionId;
  if (sessionId) await callback({ sessionId, meetingId: segment.meetingId, segmentId: segment.id, segmentSequence: segment.sequence });
}

export function validateCheckpointInput(input, meetingId, segmentId) {
  if (!isRecord(input)) invalid();
  const idempotencyKey = validateRequiredString(input.idempotencyKey, 'idempotencyKey');
  if (input.pendingPartial !== undefined && input.pendingPartial !== null) invalid();
  if (!Array.isArray(input.durableChunks)) invalid();

  const durableChunks = input.durableChunks.map((chunk) => validateDurableChunk(chunk, meetingId, segmentId));
  const finalCues = Array.isArray(input.finalCues)
    ? input.finalCues.map((cue) => validateFinalCue(cue))
    : [];
  return {
    mode: input.mode === 'transcription' ? 'transcription' : null,
    idempotencyKey,
    durableChunks: sortChunks(durableChunks),
    finalCues,
    refinedSubtitleCues: normalizeRefinedSubtitleCues(input.refinedSubtitleCues),
    refinedSubtitleRevision: positiveOrZero(input.refinedSubtitleRevision),
    refinedSubtitleInputHash: optionalString(input.refinedSubtitleInputHash),
    refinedSubtitleStatus: validRefinedSubtitleStatus(input.refinedSubtitleStatus),
    cueCheckpoint: normalizeCueCheckpoint(input.cueCheckpoint),
    pendingPartial: null
  };
}

export function mergeCheckpoint({ existing, incoming, meetingId, segmentId, sessionRepository, updatedAt } = {}) {
  const normalizedExisting = normalizeStoredCheckpoint(existing, meetingId, segmentId);
  if (incoming.cueCheckpoint && normalizedExisting.cueCheckpoint) {
    const prior = normalizedExisting.cueCheckpoint;
    const next = normalizeCueCheckpoint(incoming.cueCheckpoint);
    if (next.nextSequence < prior.nextSequence ||
        next.lastCommittedCueSequence < prior.lastCommittedCueSequence ||
        (next.lastFinalizedAtMs !== null && prior.lastFinalizedAtMs !== null &&
          next.lastFinalizedAtMs < prior.lastFinalizedAtMs)) {
      throw checkpointConflict('stale cue checkpoint snapshot');
    }
  }
  if (incoming.refinedSubtitleRevision > 0 &&
      incoming.refinedSubtitleRevision < normalizedExisting.refinedSubtitleRevision) {
    throw checkpointConflict('stale refined subtitle revision');
  }
  const chunksByKey = new Map();
  const chunksBySequence = new Map();

  for (const chunk of normalizedExisting.durableChunks) {
    chunksByKey.set(chunk.idempotencyKey, chunk);
    chunksBySequence.set(sequenceKey(chunk), chunk);
  }

  for (const chunk of incoming.durableChunks) {
    const existingByKey = chunksByKey.get(chunk.idempotencyKey);
    if (existingByKey) {
      const merged = mergeCompatibleChunks(existingByKey, chunk);
      if (!merged) {
        throw codedError('checkpoint_conflict', `checkpoint chunk conflict: ${chunk.idempotencyKey}`);
      }
      chunksByKey.set(existingByKey.idempotencyKey, merged);
      chunksBySequence.set(sequenceKey(merged), merged);
      continue;
    }

    const existingBySequence = chunksBySequence.get(sequenceKey(chunk));
    if (existingBySequence) {
      const merged = mergeCompatibleChunks(existingBySequence, chunk);
      if (!merged) {
        throw codedError('checkpoint_conflict', `checkpoint sequence conflict: ${chunk.stream}:${chunk.sequence}`);
      }
      chunksByKey.delete(existingBySequence.idempotencyKey);
      chunksByKey.set(merged.idempotencyKey, merged);
      chunksBySequence.set(sequenceKey(merged), merged);
      continue;
    }

    chunksByKey.set(chunk.idempotencyKey, chunk);
    chunksBySequence.set(sequenceKey(chunk), chunk);
  }

  const existingCues = normalizedExisting.finalCues;
  const mergedCues = [...existingCues];
  for (const cue of incoming.finalCues) {
    const result = mergeFinalCue(mergedCues, cue);
    if (result.updated) {
      const index = mergedCues.findIndex((existingCue) => existingCue.cueId === result.cue.cueId);
      if (index >= 0) mergedCues[index] = result.cue;
    } else if (result.appended) {
      mergedCues.push(result.cue);
    }
  }
  for (const cue of mergedCues) {
    if (cue.segmentId !== segmentId) invalid();
  }

  return {
    mode: incoming.mode || normalizedExisting.mode || null,
    idempotencyKey: incoming.idempotencyKey,
    durableChunks: sortChunks(Array.from(chunksByKey.values())),
    finalCues: mergedCues.sort((left, right) => left.sequence - right.sequence),
    refinedSubtitleCues: incoming.refinedSubtitleCues?.length ? incoming.refinedSubtitleCues : normalizedExisting.refinedSubtitleCues,
    refinedSubtitleRevision: incoming.refinedSubtitleRevision > 0 ? incoming.refinedSubtitleRevision : normalizedExisting.refinedSubtitleRevision,
    refinedSubtitleInputHash: incoming.refinedSubtitleInputHash || normalizedExisting.refinedSubtitleInputHash,
    refinedSubtitleStatus: incoming.refinedSubtitleStatus !== 'pending' ? incoming.refinedSubtitleStatus : normalizedExisting.refinedSubtitleStatus,
    cueCheckpoint: incoming.cueCheckpoint ?? normalizedExisting.cueCheckpoint,
    pendingPartial: null,
    updatedAt
  };
}

export function normalizeStoredCheckpoint(checkpoint, meetingId, segmentId) {
  if (checkpoint === null || checkpoint === undefined) {
    return {
      mode: null,
      idempotencyKey: null,
      durableChunks: [],
      finalCues: [],
      refinedSubtitleCues: [],
      refinedSubtitleRevision: 0,
      refinedSubtitleInputHash: null,
      refinedSubtitleStatus: 'pending',
      cueCheckpoint: null,
      pendingPartial: null,
      updatedAt: null
    };
  }

  if (!isRecord(checkpoint) || !Array.isArray(checkpoint.durableChunks)) {
    invalid();
  }

  return {
    mode: checkpoint.mode === 'transcription' ? 'transcription' : null,
    idempotencyKey: checkpoint.idempotencyKey ?? null,
    durableChunks: sortChunks(checkpoint.durableChunks.map((chunk) => validateDurableChunk(chunk, meetingId, segmentId))),
    finalCues: Array.isArray(checkpoint.finalCues) ? checkpoint.finalCues.map((cue) => validateFinalCue(cue)) : [],
    refinedSubtitleCues: normalizeRefinedSubtitleCues(checkpoint.refinedSubtitleCues),
    refinedSubtitleRevision: positiveOrZero(checkpoint.refinedSubtitleRevision),
    refinedSubtitleInputHash: optionalString(checkpoint.refinedSubtitleInputHash),
    refinedSubtitleStatus: validRefinedSubtitleStatus(checkpoint.refinedSubtitleStatus),
    cueCheckpoint: normalizeCueCheckpoint(checkpoint.cueCheckpoint),
    pendingPartial: null,
    updatedAt: checkpoint.updatedAt ?? null
  };
}

function validateRolloverInput(input) {
  if (!isRecord(input)) invalid();
  return {
    idempotencyKey: validateRequiredString(input.idempotencyKey, 'idempotencyKey'),
    checkpoint: input.checkpoint,
    nextLiveSessionId: validateRequiredString(input.nextLiveSessionId, 'nextLiveSessionId')
  };
}

function validateRecoveryInput(input) {
  if (!isRecord(input)) invalid();
  const outcome = input.outcome;
  if (outcome !== 'interrupted' && outcome !== 'failed') invalid();

  return {
    idempotencyKey: validateRequiredString(input.idempotencyKey, 'idempotencyKey'),
    checkpoint: input.checkpoint,
    nextLiveSessionId: input.nextLiveSessionId === null || input.nextLiveSessionId === undefined
      ? null
      : validateRequiredString(input.nextLiveSessionId, 'nextLiveSessionId'),
    failureReason: validateRequiredString(input.failureReason, 'failureReason'),
    failureCategory: validateRequiredString(input.failureCategory, 'failureCategory'),
    outcome
  };
}

async function requireSegment({ meetingRepository, meetingId, segmentId }) {
  const normalizedMeetingId = validateRequiredString(meetingId, 'meetingId');
  const normalizedSegmentId = validateRequiredString(segmentId, 'segmentId');
  const meeting = await meetingRepository.getMeeting(normalizedMeetingId);
  if (!meeting) throw codedError('meeting_not_found', `Meeting not found: ${normalizedMeetingId}`);

  const segment = await meetingRepository.getMeetingSegment(normalizedSegmentId);
  if (!segment || segment.meetingId !== normalizedMeetingId) {
    throw codedError('meeting_segment_not_found', `MeetingSegment not found: ${normalizedSegmentId}`);
  }

  return segment;
}

async function validateCueIntegrity(cues, meetingRepository, sessionRepository, meetingId) {
  if (!Array.isArray(cues) || cues.length === 0 || !sessionRepository) return;
  const segments = await meetingRepository.listMeetingSegments(meetingId);
  const persisted = segments.flatMap((segment) => segment.checkpoint?.finalCues || []);
  for (const cue of cues) {
    const session = await sessionRepository.getSessionRecord(cue.sessionId);
    if (!session) throw codedError('subtitle_cue_session_not_found', `Session not found: ${cue.sessionId}`);
    if (session.sessionRecord?.meetingId !== meetingId) {
      throw codedError('subtitle_cue_segment_session_mismatch', `Cue segment does not belong to session: ${cue.cueId}`);
    }
    mergeFinalCue(persisted, cue);
  }
}

function validateDurableChunk(chunk, meetingId, segmentId) {
  if (!isRecord(chunk)) invalid();
  const normalized = {
    idempotencyKey: validateRequiredString(chunk.idempotencyKey, 'chunk.idempotencyKey'),
    meetingId: validateRequiredString(chunk.meetingId, 'chunk.meetingId'),
    segmentId: validateRequiredString(chunk.segmentId, 'chunk.segmentId'),
    stream: validateStream(chunk.stream),
    sequence: validateSequence(chunk.sequence),
    text: validateText(chunk.text),
    timestamp: validateTimestamp(chunk.timestamp)
  };

  if (normalized.meetingId !== meetingId || normalized.segmentId !== segmentId) invalid();
  return normalized;
}

function validateRequiredString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    invalid(`${field} must be a non-empty string`);
  }

  return value;
}

function validateStream(value) {
  if (value !== 'source' && value !== 'translation') invalid();
  return value;
}

function validateSequence(value) {
  if (!Number.isInteger(value) || value < 0) invalid();
  return value;
}

function validateText(value) {
  if (typeof value !== 'string') invalid();
  return value;
}

function validateTimestamp(value) {
  if (typeof value === 'string' && value.trim().length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  invalid();
}

function sortChunks(chunks) {
  return [...chunks].sort((left, right) => (
    STREAM_ORDER[left.stream] - STREAM_ORDER[right.stream] ||
    left.sequence - right.sequence ||
    left.idempotencyKey.localeCompare(right.idempotencyKey)
  ));
}

function sequenceKey(chunk) {
  return `${chunk.stream}:${chunk.sequence}`;
}

function mergeCompatibleChunks(existing, incoming) {
  if (existing.meetingId !== incoming.meetingId || existing.segmentId !== incoming.segmentId || existing.stream !== incoming.stream || existing.sequence !== incoming.sequence) {
    return null;
  }
  if (!isTextExtension(existing.text, incoming.text) && !isTextExtension(incoming.text, existing.text)) {
    return null;
  }
  return incoming.text.length >= existing.text.length ? incoming : existing;
}

function isTextExtension(existingText, incomingText) {
  return existingText === incomingText || existingText === '' || incomingText.startsWith(existingText);
}

function sameErrorInfo(left, right) {
  return left?.reason === right?.reason && left?.category === right?.category;
}

function normalizeRefinedSubtitleCues(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) invalid('refinedSubtitleCues must be an array');
  return value.map((cue) => {
    if (!isRecord(cue) || typeof cue.cueId !== 'string' || !Array.isArray(cue.sourceCueIds) || cue.sourceCueIds.length === 0 ||
      typeof cue.sourceText !== 'string' || !cue.sourceText.trim() || typeof cue.translatedText !== 'string' || !cue.translatedText.trim() ||
      !Number.isFinite(cue.startTimeMs) || !Number.isFinite(cue.endTimeMs) || cue.endTimeMs <= cue.startTimeMs || cue.status !== 'final') invalid('refinedSubtitleCue is invalid');
    return { ...cue, sourceCueIds: [...cue.sourceCueIds] };
  });
}

function positiveOrZero(value) { return Number.isInteger(value) && value >= 0 ? value : 0; }
function optionalString(value) { return typeof value === 'string' && value.trim() ? value : null; }
function validRefinedSubtitleStatus(value) { return ['pending', 'queued', 'running', 'completed', 'failed'].includes(value) ? value : 'pending'; }

function assertMeetingRepository(repository) {
  for (const method of ['createMeeting', 'getMeeting', 'updateMeeting', 'listMeetingSegments', 'createMeetingSegment', 'getMeetingSegment', 'updateMeetingSegment']) {
    if (!repository || typeof repository[method] !== 'function') {
      throw new TypeError(`meetingRepository.${method} is required.`);
    }
  }
}

function invalid(message = 'Checkpoint is invalid.') {
  throw codedError('invalid_request', message, TypeError);
}

function codedError(code, message, ErrorType = Error) {
  const error = new ErrorType(message);
  error.code = code;
  return error;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function defaultIdGenerator(prefix) {
  return `${prefix}-${Date.now()}`;
}
