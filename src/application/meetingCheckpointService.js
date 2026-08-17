import { isTerminalMeetingSegmentStatus } from '../domain/meeting/index.js';
import { mergeFinalCue, normalizeCueCheckpoint, validateFinalCue } from '../domain/subtitleCue/index.js';

const STREAM_ORDER = Object.freeze({ source: 0, translation: 1 });

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

  return Object.freeze({
    async createMeeting({
      liveSessionId = null,
      glossaryEntries = [],
      name = null,
      sourceLanguageCode = null,
      targetLanguageCode = null,
      draft = false
    } = {}) {
      const now = clock();
      const meeting = await meetingRepository.createMeeting({
        id: idGenerator('meeting'),
        createdAt: now,
        glossaryEntries,
        name,
        sourceLanguageCode,
        targetLanguageCode
      });
      const activeMeeting = draft
        ? meeting
        : await meetingRepository.updateMeeting(meeting.activate(now));
      const segment = await meetingRepository.createMeetingSegment({
        id: idGenerator('segment'),
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
        ? await meetingRepository.updateMeetingSegment(withLiveSession.activate(now))
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
        checkpoint: normalizeStoredCheckpoint(segment.checkpoint, segment.meetingId, segment.id)
      };
    },

    async updateCheckpoint({ meetingId, segmentId, checkpoint } = {}) {
      const segment = await requireSegment({ meetingRepository, meetingId, segmentId });
      if (isTerminalMeetingSegmentStatus(segment.status)) {
        throw codedError('meeting_segment_invalid_state', `checkpoint cannot be changed for ${segment.status} segment`);
      }

      const now = clock();
      const incoming = validateCheckpointInput(checkpoint, segment.meetingId, segment.id);
      await validateCueIntegrity(incoming.finalCues, meetingRepository, sessionRepository, segment.meetingId);
      const nextCheckpoint = mergeCheckpoint({
        existing: segment.checkpoint,
        incoming,
        meetingId: segment.meetingId,
        segmentId: segment.id,
        sessionRepository,
        updatedAt: now
      });
      const updated = await meetingRepository.updateMeetingSegment(segment.withCheckpoint(nextCheckpoint, now));
      return {
        meetingId: updated.meetingId,
        segmentId: updated.id,
        checkpoint: updated.checkpoint
      };
    },

    async rolloverSegment({ meetingId, segmentId, rollover } = {}) {
      const currentSegment = await requireSegment({ meetingRepository, meetingId, segmentId });
      const input = validateRolloverInput(rollover);
      const existingSegments = await meetingRepository.listMeetingSegments(currentSegment.meetingId);
      const existingNext = existingSegments.find((segment) => segment.sequence === currentSegment.sequence + 1);
      const storedCheckpoint = normalizeStoredCheckpoint(currentSegment.checkpoint, currentSegment.meetingId, currentSegment.id);
      if (
        existingNext &&
        currentSegment.status === 'completed' &&
        storedCheckpoint.idempotencyKey === input.idempotencyKey &&
        existingNext.liveSessionId === input.nextLiveSessionId
      ) {
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
      const nextCheckpoint = mergeCheckpoint({
        existing: currentSegment.checkpoint,
        incoming,
        meetingId: currentSegment.meetingId,
        segmentId: currentSegment.id,
        sessionRepository,
        updatedAt: now
      });
      const rolloverCheckpoint = { ...nextCheckpoint, idempotencyKey: input.idempotencyKey, updatedAt: now };
      const completedSegment = await meetingRepository.updateMeetingSegment(currentSegment.complete({
        endedAt: now,
        checkpoint: rolloverCheckpoint
      }));
      const nextSegment = await meetingRepository.createMeetingSegment({
        id: idGenerator('segment'),
        meetingId: currentSegment.meetingId,
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
      const nextCheckpoint = mergeCheckpoint({
        existing: currentSegment.checkpoint,
        incoming,
        meetingId: currentSegment.meetingId,
        segmentId: currentSegment.id,
        sessionRepository,
        updatedAt: now
      });
      const recoveryCheckpoint = { ...nextCheckpoint, idempotencyKey: input.idempotencyKey, updatedAt: now };

      if (input.outcome === 'failed') {
        const failedSegment = await meetingRepository.updateMeetingSegment(currentSegment.fail({
          endedAt: now,
          checkpoint: recoveryCheckpoint,
          errorInfo
        }));
        await notifySegmentFinalized(onSegmentFinalized, failedSegment);
        return { failedSegment };
      }

      const interruptedSegment = await meetingRepository.updateMeetingSegment(currentSegment.interrupt({
        endedAt: now,
        checkpoint: recoveryCheckpoint,
        errorInfo
      }));
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

function meetingSettingsSnapshot(meeting) {
  return meeting ? {
    name: meeting.name,
    sourceLanguageCode: meeting.sourceLanguageCode,
    targetLanguageCode: meeting.targetLanguageCode,
    glossaryEntries: meeting.glossaryEntries.map((entry) => ({ ...entry, replacementAliases: [...entry.replacementAliases] }))
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
    idempotencyKey,
    durableChunks: sortChunks(durableChunks),
    finalCues,
    cueCheckpoint: normalizeCueCheckpoint(input.cueCheckpoint),
    pendingPartial: null
  };
}

export function mergeCheckpoint({ existing, incoming, meetingId, segmentId, sessionRepository, updatedAt } = {}) {
  const normalizedExisting = normalizeStoredCheckpoint(existing, meetingId, segmentId);
  const chunksByKey = new Map();
  const chunksBySequence = new Map();

  for (const chunk of normalizedExisting.durableChunks) {
    chunksByKey.set(chunk.idempotencyKey, chunk);
    chunksBySequence.set(sequenceKey(chunk), chunk);
  }

  for (const chunk of incoming.durableChunks) {
    const existingByKey = chunksByKey.get(chunk.idempotencyKey);
    if (existingByKey) {
      if (!sameChunk(existingByKey, chunk)) {
        throw codedError('checkpoint_conflict', `checkpoint chunk conflict: ${chunk.idempotencyKey}`);
      }
      continue;
    }

    const existingBySequence = chunksBySequence.get(sequenceKey(chunk));
    if (existingBySequence && !sameChunk(existingBySequence, chunk)) {
      throw codedError('checkpoint_conflict', `checkpoint sequence conflict: ${chunk.stream}:${chunk.sequence}`);
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
    idempotencyKey: incoming.idempotencyKey,
    durableChunks: sortChunks(Array.from(chunksByKey.values())),
    finalCues: mergedCues.sort((left, right) => left.sequence - right.sequence),
    cueCheckpoint: incoming.cueCheckpoint ?? normalizedExisting.cueCheckpoint,
    pendingPartial: null,
    updatedAt
  };
}

export function normalizeStoredCheckpoint(checkpoint, meetingId, segmentId) {
  if (checkpoint === null || checkpoint === undefined) {
    return {
      idempotencyKey: null,
      durableChunks: [],
      finalCues: [],
      cueCheckpoint: null,
      pendingPartial: null,
      updatedAt: null
    };
  }

  if (!isRecord(checkpoint) || !Array.isArray(checkpoint.durableChunks)) {
    invalid();
  }

  return {
    idempotencyKey: checkpoint.idempotencyKey ?? null,
    durableChunks: sortChunks(checkpoint.durableChunks.map((chunk) => validateDurableChunk(chunk, meetingId, segmentId))),
    finalCues: Array.isArray(checkpoint.finalCues) ? checkpoint.finalCues.map((cue) => validateFinalCue(cue)) : [],
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

function sameChunk(left, right) {
  return left.idempotencyKey === right.idempotencyKey &&
    left.meetingId === right.meetingId &&
    left.segmentId === right.segmentId &&
    left.stream === right.stream &&
    left.sequence === right.sequence &&
    left.text === right.text &&
    left.timestamp === right.timestamp;
}

function sameErrorInfo(left, right) {
  return left?.reason === right?.reason && left?.category === right?.category;
}

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
