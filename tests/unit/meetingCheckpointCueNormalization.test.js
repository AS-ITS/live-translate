import assert from 'node:assert/strict';
import test from 'node:test';
import { createMeetingCheckpointService } from '../../src/application/meetingCheckpointService.js';
import { createMemoryMeetingRepository } from '../../src/infrastructure/meetingRepositoryAdapter.js';

test('checkpoint treats persisted cue metadata normalization as idempotent', async () => {
  const repository = createMemoryMeetingRepository();
  const service = createMeetingCheckpointService({
    meetingRepository: repository,
    idGenerator(prefix) {
      return prefix === 'meeting' ? 'meeting-1' : 'segment-1';
    },
    clock: () => 1000
  });
  const { meeting, segment } = await service.createMeeting();
  const cue = {
    cueId: 'cue:session-1:segment-1:1',
    sessionId: 'session-1',
    segmentId: segment.id,
    sequence: 1,
    startTimeMs: 0,
    endTimeMs: 100,
    sourceLanguageCode: 'zh-Hant',
    targetLanguageCode: 'en',
    sourceText: '你好',
    translatedText: 'hello',
    status: 'final',
    finalizedReason: 'final'
  };

  await service.updateCheckpoint({
    meetingId: meeting.id,
    segmentId: segment.id,
    checkpoint: {
      idempotencyKey: 'checkpoint-1',
      durableChunks: [],
      finalCues: [cue],
      pendingPartial: null
    }
  });

  await service.updateCheckpoint({
    meetingId: meeting.id,
    segmentId: segment.id,
    checkpoint: {
      idempotencyKey: 'checkpoint-2',
      durableChunks: [],
      finalCues: [{ ...cue, finalizedReason: 'generationComplete' }],
      pendingPartial: null
    }
  });

  const result = await service.getCheckpoint({ meetingId: meeting.id, segmentId: segment.id });
  assert.deepEqual(result.checkpoint.finalCues, [{
    ...cue,
    sourceStatus: 'finalized',
    translationStatus: 'finalized',
    sourceVersion: 1,
    translationVersion: 1
  }]);
});
