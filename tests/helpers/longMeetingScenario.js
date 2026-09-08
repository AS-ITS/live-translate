export const LONG_MEETING_DURATION_MS = 135 * 60 * 1000;
export const LONG_MEETING_SEGMENT_INTERVAL_MS = 15 * 60 * 1000;
export const LONG_MEETING_SEGMENT_COUNT = Math.ceil(LONG_MEETING_DURATION_MS / LONG_MEETING_SEGMENT_INTERVAL_MS);
export const LONG_MEETING_SOAK_DURATION_MS = 130 * 60 * 1000;
export const LONG_MEETING_SOAK_ROLLOVER_COUNT = 8;
export const LONG_MEETING_SOAK_SEGMENT_COUNT = 9;

export function buildLongMeetingScenario({
  meetingId = 'meeting-1',
  segmentPrefix = 'segment',
  liveSessionPrefix = 'live-session',
  durationMs = LONG_MEETING_DURATION_MS,
  segmentCount = Math.ceil(durationMs / LONG_MEETING_SEGMENT_INTERVAL_MS),
  closeActionForSegment = longMeetingCloseAction
} = {}) {
  const segments = [];
  let sequence = 1;

  for (let index = 0; index < segmentCount; index += 1) {
    const segmentNumber = index + 1;
    const segmentId = `${segmentPrefix}-${segmentNumber}`;
    const startedAt = index * LONG_MEETING_SEGMENT_INTERVAL_MS;
    const endedAt = Math.min(startedAt + LONG_MEETING_SEGMENT_INTERVAL_MS, durationMs);
    const sourceSequence = sequence;
    const translationSequence = sequence + 1;
    sequence += 2;

    segments.push({
      id: segmentId,
      sequence: index,
      startedAt,
      endedAt,
      liveSessionId: `${liveSessionPrefix}-${segmentNumber}`,
      nextLiveSessionId: `${liveSessionPrefix}-${segmentNumber + 1}`,
      closeAction: closeActionForSegment(segmentNumber),
      chunks: [
        {
          idempotencyKey: `checkpoint:${segmentId}:source:${sourceSequence}`,
          meetingId,
          segmentId,
          stream: 'source',
          sequence: sourceSequence,
          text: `long meeting source segment ${segmentNumber}`,
          timestamp: startedAt + 1000
        },
        {
          idempotencyKey: `checkpoint:${segmentId}:translation:${translationSequence}`,
          meetingId,
          segmentId,
          stream: 'translation',
          sequence: translationSequence,
          text: `long meeting translation segment ${segmentNumber}`,
          timestamp: startedAt + 2000
        }
      ]
    });
  }

  return {
    durationMs,
    intervalMs: LONG_MEETING_SEGMENT_INTERVAL_MS,
    meetingId,
    segments,
    expectedChunks: segments.flatMap((segment) => segment.chunks)
  };
}

export function buildLongMeetingSoakScenario(options = {}) {
  return buildLongMeetingScenario({
    ...options,
    durationMs: LONG_MEETING_SOAK_DURATION_MS,
    segmentCount: LONG_MEETING_SOAK_SEGMENT_COUNT,
    closeActionForSegment(segmentNumber) {
      if (segmentNumber === 7) {
        return { type: 'recover', failureReason: 'network_interrupted', failureCategory: 'network' };
      }
      return { type: 'rollover' };
    }
  });
}

export async function runLongMeetingCheckpointScenario({ service } = {}) {
  if (!service || typeof service.createMeeting !== 'function') {
    throw new TypeError('service.createMeeting is required.');
  }

  const scenario = buildLongMeetingScenario();
  const start = await service.createMeeting({ liveSessionId: scenario.segments[0].liveSessionId });
  let currentSegment = start.segment;

  for (const segment of scenario.segments) {
    if (currentSegment.id !== segment.id) {
      throw new Error(`scenario segment mismatch: expected ${segment.id}, got ${currentSegment.id}`);
    }

    const checkpoint = checkpointForSegment(segment, `checkpoint:${segment.id}:sync`);
    await service.updateCheckpoint({
      meetingId: start.meeting.id,
      segmentId: currentSegment.id,
      checkpoint
    });

    if (segment.sequence === scenario.segments.length - 1) {
      break;
    }

    const closeInput = {
      idempotencyKey: `${segment.closeAction.type}:${segment.id}`,
      checkpoint: checkpointForSegment(segment, `checkpoint:${segment.id}:${segment.closeAction.type}`),
      nextLiveSessionId: segment.nextLiveSessionId
    };

    if (segment.closeAction.type === 'recover') {
      const recovered = await service.recoverSegment({
        meetingId: start.meeting.id,
        segmentId: currentSegment.id,
        recovery: {
          ...closeInput,
          failureReason: segment.closeAction.failureReason,
          failureCategory: segment.closeAction.failureCategory,
          outcome: 'interrupted'
        }
      });
      currentSegment = recovered.segment;
    } else {
      const rolled = await service.rolloverSegment({
        meetingId: start.meeting.id,
        segmentId: currentSegment.id,
        rollover: closeInput
      });
      currentSegment = rolled.segment;
    }
  }

  return {
    ...scenario,
    meeting: start.meeting,
    activeSegment: currentSegment
  };
}

export async function runFailedSegmentCheckpointScenario({ service } = {}) {
  if (!service || typeof service.createMeeting !== 'function') {
    throw new TypeError('service.createMeeting is required.');
  }

  const start = await service.createMeeting({ liveSessionId: 'failed-live-session-1' });
  const chunks = [
    {
      idempotencyKey: 'checkpoint:failed-segment:source:1',
      meetingId: start.meeting.id,
      segmentId: start.segment.id,
      stream: 'source',
      sequence: 1,
      text: 'source before terminal segment failure',
      timestamp: 1000
    },
    {
      idempotencyKey: 'checkpoint:failed-segment:translation:2',
      meetingId: start.meeting.id,
      segmentId: start.segment.id,
      stream: 'translation',
      sequence: 2,
      text: 'translation before terminal segment failure',
      timestamp: 2000
    }
  ];

  await service.updateCheckpoint({
    meetingId: start.meeting.id,
    segmentId: start.segment.id,
    checkpoint: {
      idempotencyKey: 'checkpoint:failed-segment:sync',
      durableChunks: chunks,
      pendingPartial: null
    }
  });

  const failed = await service.recoverSegment({
    meetingId: start.meeting.id,
    segmentId: start.segment.id,
    recovery: {
      idempotencyKey: 'recover:failed-segment',
      checkpoint: {
        idempotencyKey: 'checkpoint:failed-segment:recover',
        durableChunks: chunks,
        pendingPartial: null
      },
      nextLiveSessionId: 'failed-live-session-2',
      failureReason: 'provider_error',
      failureCategory: 'provider',
      outcome: 'failed'
    }
  });

  return { meeting: start.meeting, failedSegment: failed.failedSegment, expectedChunks: chunks };
}

export function reconstructChunkText(chunks = [], stream) {
  return chunks
    .filter((chunk) => chunk.stream === stream)
    .sort((left, right) => left.sequence - right.sequence)
    .map((chunk) => chunk.text)
    .join('\n');
}

export function assertNoMissingDuplicateOrOutOfOrderChunks(assert, chunks = [], expectedChunks = []) {
  assert.equal(chunks.length, expectedChunks.length);
  assert.deepEqual(
    chunks.map(chunkIdentity),
    expectedChunks.map(chunkIdentity)
  );
  assert.deepEqual(
    chunks.map((chunk) => `${chunk.stream}:${chunk.sequence}:${chunk.text}`),
    expectedChunks.map((chunk) => `${chunk.stream}:${chunk.sequence}:${chunk.text}`)
  );
  assert.equal(new Set(chunks.map(chunkIdentity)).size, chunks.length);
}

export function checkpointForSegment(segment, idempotencyKey) {
  return {
    idempotencyKey,
    durableChunks: segment.chunks,
    pendingPartial: null
  };
}

function longMeetingCloseAction(segmentNumber) {
  if (segmentNumber === 4) {
    return { type: 'recover', failureReason: 'token_expired', failureCategory: 'token' };
  }
  if (segmentNumber === 8) {
    return { type: 'recover', failureReason: 'network_interrupted', failureCategory: 'network' };
  }
  return { type: 'rollover' };
}

function chunkIdentity(chunk) {
  return chunk.idempotencyKey ?? chunk.id;
}
