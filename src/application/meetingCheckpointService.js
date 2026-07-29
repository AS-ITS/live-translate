import { isTerminalMeetingSegmentStatus } from '../domain/meeting/index.js';

const STREAM_ORDER = Object.freeze({ source: 0, translation: 1 });

export function createMeetingCheckpointService({
  meetingRepository,
  idGenerator = defaultIdGenerator,
  clock = () => Date.now()
} = {}) {
  assertMeetingRepository(meetingRepository);
  if (typeof idGenerator !== 'function') throw new TypeError('idGenerator is required.');
  if (typeof clock !== 'function') throw new TypeError('clock is required.');

  return Object.freeze({
    async createMeeting({ liveSessionId = null } = {}) {
      const now = clock();
      const meeting = await meetingRepository.createMeeting({ id: idGenerator('meeting'), createdAt: now });
      const activeMeeting = await meetingRepository.updateMeeting(meeting.activate(now));
      const segment = await meetingRepository.createMeetingSegment({
        id: idGenerator('segment'),
        meetingId: activeMeeting.id,
        sequence: 0,
        liveSessionId: liveSessionId === null ? null : validateRequiredString(liveSessionId, 'liveSessionId'),
        createdAt: now
      });
      const activeSegment = await meetingRepository.updateMeetingSegment(segment.activate(now));

      return { meeting: activeMeeting, segment: activeSegment };
    },

    async listMeetingSegments(meetingId) {
      const normalizedMeetingId = validateRequiredString(meetingId, 'meetingId');
      const meeting = await meetingRepository.getMeeting(normalizedMeetingId);
      if (!meeting) throw codedError('meeting_not_found', `Meeting not found: ${normalizedMeetingId}`);
      return meetingRepository.listMeetingSegments(normalizedMeetingId);
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
      const nextCheckpoint = mergeCheckpoint({
        existing: segment.checkpoint,
        incoming: validateCheckpointInput(checkpoint, segment.meetingId, segment.id),
        meetingId: segment.meetingId,
        segmentId: segment.id,
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
      const nextCheckpoint = mergeCheckpoint({
        existing: currentSegment.checkpoint,
        incoming: validateCheckpointInput(input.checkpoint, currentSegment.meetingId, currentSegment.id),
        meetingId: currentSegment.meetingId,
        segmentId: currentSegment.id,
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
        createdAt: now
      });
      const activeNextSegment = await meetingRepository.updateMeetingSegment(nextSegment.activate(now));

      return { completedSegment, segment: activeNextSegment };
    }
  });
}

export function validateCheckpointInput(input, meetingId, segmentId) {
  if (!isRecord(input)) invalid();
  const idempotencyKey = validateRequiredString(input.idempotencyKey, 'idempotencyKey');
  if (input.pendingPartial !== undefined && input.pendingPartial !== null) invalid();
  if (!Array.isArray(input.durableChunks)) invalid();

  const durableChunks = input.durableChunks.map((chunk) => validateDurableChunk(chunk, meetingId, segmentId));
  return {
    idempotencyKey,
    durableChunks: sortChunks(durableChunks),
    pendingPartial: null
  };
}

export function mergeCheckpoint({ existing, incoming, meetingId, segmentId, updatedAt } = {}) {
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

  return {
    idempotencyKey: incoming.idempotencyKey,
    durableChunks: sortChunks(Array.from(chunksByKey.values())),
    pendingPartial: null,
    updatedAt
  };
}

export function normalizeStoredCheckpoint(checkpoint, meetingId, segmentId) {
  if (checkpoint === null || checkpoint === undefined) {
    return {
      idempotencyKey: null,
      durableChunks: [],
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
