import assert from 'node:assert/strict';
import test from 'node:test';
import { createMeetingCheckpointService, meetingSettingsSnapshot } from '../../src/application/meetingCheckpointService.js';
import { createMemoryMeetingRepository } from '../../src/infrastructure/meetingRepositoryAdapter.js';
import { transcriptItemsFromSegments } from '../../src/readModels/meetingReadModels.js';
import {
  assertNoMissingDuplicateOrOutOfOrderChunks,
  reconstructChunkText,
  runFailedSegmentCheckpointScenario,
  runLongMeetingCheckpointScenario
} from '../helpers/longMeetingScenario.js';

test('creates an active meeting with the first active segment', async () => {
  const repository = createMemoryMeetingRepository();
  const service = createService(repository);

  const { meeting, segment } = await service.createMeeting();

  assert.equal(meeting.id, 'meeting-1');
  assert.equal(meeting.status, 'active');
  assert.equal(segment.id, 'segment-1');
  assert.equal(segment.meetingId, meeting.id);
  assert.equal(segment.sequence, 0);
  assert.equal(segment.status, 'active');
});

test('persists Meeting audio settings in the Meeting and Segment snapshot', async () => {
  const repository = createMemoryMeetingRepository();
  const service = createService(repository);
  const { meeting, segment } = await service.createMeeting({
    draft: true,
    echoTargetLanguage: false,
    shouldRecordInputAudio: true
  });

  assert.equal(meeting.echoTargetLanguage, false);
  assert.equal(meeting.shouldRecordInputAudio, true);
  assert.equal(segment.settingsSnapshot.echoTargetLanguage, false);
  assert.equal(segment.settingsSnapshot.shouldRecordInputAudio, true);
});

test('meeting settings snapshots normalize legacy glossary aliases for recovered segments', async () => {
  const baseRepository = createMemoryMeetingRepository();
  const repository = {
    ...baseRepository,
    getMeeting(meetingId) {
      const meeting = baseRepository.getMeeting(meetingId);
      return meeting
        ? { ...meeting, glossaryEntries: [{ ...meeting.glossaryEntries[0], replacementAliases: { en: ['legacy'] } }] }
        : null;
    }
  };
  const service = createService(repository);
  const { meeting, segment } = await service.createMeeting({
    glossaryEntries: [{ source: 'microphone', target: 'Alan speak', replacementAliases: ['mic'] }],
    liveSessionId: 'live-session-1'
  });

  const result = await service.recoverSegment({
    meetingId: meeting.id,
    segmentId: segment.id,
    recovery: recovery({ nextLiveSessionId: 'live-session-2' })
  });

  assert.deepEqual(result.segment.settingsSnapshot.glossaryEntries, [{
    source: 'microphone',
    target: 'Alan speak',
    replacementAliases: []
  }]);
  assert.deepEqual(meetingSettingsSnapshot({
    ...meeting,
    glossaryEntries: [{ source: 'microphone', target: 'Alan speak', replacementAliases: ['mic'] }]
  }).glossaryEntries[0].replacementAliases, ['mic']);
});

test('completed meeting settings are locked', async () => {
  const repository = createMemoryMeetingRepository();
  const service = createService(repository);
  const { meeting } = await service.createMeeting({ draft: true });
  await service.completeMeeting({ meetingId: meeting.id });

  await assert.rejects(
    service.updateMeeting({ meetingId: meeting.id, settings: { name: '不應修改' } }),
    (error) => error.code === 'meeting_settings_locked'
  );
});

test('checkpoint updates merge out-of-order chunks and read them back sorted', async () => {
  const repository = createMemoryMeetingRepository();
  const service = createService(repository);
  const { meeting, segment } = await service.createMeeting();

  await service.updateCheckpoint({
    meetingId: meeting.id,
    segmentId: segment.id,
    checkpoint: checkpoint({
      durableChunks: [
        chunk({ stream: 'translation', sequence: 2, text: 'world' }),
        chunk({ stream: 'source', sequence: 1, text: 'hello' })
      ]
    })
  });

  const result = await service.getCheckpoint({ meetingId: meeting.id, segmentId: segment.id });

  assert.deepEqual(
    result.checkpoint.durableChunks.map(({ stream, sequence, text }) => ({ stream, sequence, text })),
    [
      { stream: 'source', sequence: 1, text: 'hello' },
      { stream: 'translation', sequence: 2, text: 'world' }
    ]
  );
  assert.equal(result.checkpoint.pendingPartial, null);
});

test('duplicate checkpoint chunks are idempotent', async () => {
  const repository = createMemoryMeetingRepository();
  const service = createService(repository);
  const { meeting, segment } = await service.createMeeting();
  const input = checkpoint({ durableChunks: [chunk({ sequence: 1, text: 'hello' })] });

  await service.updateCheckpoint({ meetingId: meeting.id, segmentId: segment.id, checkpoint: input });
  await service.updateCheckpoint({ meetingId: meeting.id, segmentId: segment.id, checkpoint: input });

  const result = await service.getCheckpoint({ meetingId: meeting.id, segmentId: segment.id });
  assert.equal(result.checkpoint.durableChunks.length, 1);
});

test('checkpoint updates an existing cue when a later merged payload only extends it', async () => {
  const repository = createMemoryMeetingRepository();
  const service = createService(repository);
  const { meeting, segment } = await service.createMeeting();
  const baseCue = finalCue({ segmentId: segment.id, sourceText: '你好', translatedText: 'hello' });
  const mergedCue = { ...baseCue, sourceText: '你好世界', translatedText: 'hello world', endTimeMs: 200, finalizedReason: 'merged' };

  await service.updateCheckpoint({ meetingId: meeting.id, segmentId: segment.id, checkpoint: checkpoint({ finalCues: [baseCue] }) });
  await service.updateCheckpoint({ meetingId: meeting.id, segmentId: segment.id, checkpoint: checkpoint({ finalCues: [mergedCue] }) });

  const result = await service.getCheckpoint({ meetingId: meeting.id, segmentId: segment.id });
  assert.deepEqual(result.checkpoint.finalCues, [mergedCue]);
});

test('checkpoint rejects conflicting idempotency keys and duplicate stream sequences', async () => {
  const repository = createMemoryMeetingRepository();
  const service = createService(repository);
  const { meeting, segment } = await service.createMeeting();

  await service.updateCheckpoint({
    meetingId: meeting.id,
    segmentId: segment.id,
    checkpoint: checkpoint({ durableChunks: [chunk({ sequence: 1, text: 'hello' })] })
  });

  await assert.rejects(
    service.updateCheckpoint({
      meetingId: meeting.id,
      segmentId: segment.id,
      checkpoint: checkpoint({ durableChunks: [chunk({ sequence: 1, text: 'changed' })] })
    }),
    /checkpoint chunk conflict/
  );

  await assert.rejects(
    service.updateCheckpoint({
      meetingId: meeting.id,
      segmentId: segment.id,
      checkpoint: checkpoint({ durableChunks: [chunk({ idempotencyKey: 'chunk-source-1b', sequence: 1, text: 'changed' })] })
    }),
    /checkpoint sequence conflict/
  );
});

test('terminal segments reject checkpoint updates', async () => {
  const repository = createMemoryMeetingRepository();
  const service = createService(repository);
  const { meeting, segment } = await service.createMeeting();
  await repository.updateMeetingSegment(segment.complete({ endedAt: 2000 }));

  await assert.rejects(
    service.updateCheckpoint({
      meetingId: meeting.id,
      segmentId: segment.id,
      checkpoint: checkpoint({ durableChunks: [chunk({ sequence: 1, text: 'hello' })] })
    }),
    /checkpoint cannot be changed/
  );
});

test('checkpoint validation rejects pending partials and mismatched ownership', async () => {
  const repository = createMemoryMeetingRepository();
  const service = createService(repository);
  const { meeting, segment } = await service.createMeeting();

  await assert.rejects(
    service.updateCheckpoint({
      meetingId: meeting.id,
      segmentId: segment.id,
      checkpoint: { ...checkpoint(), pendingPartial: { text: 'draft' } }
    }),
    /Checkpoint is invalid/
  );

  await assert.rejects(
    service.updateCheckpoint({
      meetingId: meeting.id,
      segmentId: segment.id,
      checkpoint: checkpoint({ durableChunks: [chunk({ meetingId: 'other-meeting' })] })
    }),
    /Checkpoint is invalid/
  );
});

test('rollover completes current segment and creates next active segment', async () => {
  const repository = createMemoryMeetingRepository();
  const service = createService(repository);
  const { meeting, segment } = await service.createMeeting({ liveSessionId: 'live-session-1' });

  const result = await service.rolloverSegment({
    meetingId: meeting.id,
    segmentId: segment.id,
    rollover: {
      idempotencyKey: 'rollover-1',
      checkpoint: checkpoint({ durableChunks: [chunk({ sequence: 1, text: 'hello' })] }),
      nextLiveSessionId: 'live-session-2'
    }
  });

  assert.equal(result.completedSegment.status, 'completed');
  assert.equal(result.completedSegment.liveSessionId, 'live-session-1');
  assert.equal(result.completedSegment.checkpoint.idempotencyKey, 'rollover-1');
  assert.equal(result.completedSegment.checkpoint.durableChunks.length, 1);
  assert.equal(result.segment.id, 'segment-2');
  assert.equal(result.segment.sequence, 1);
  assert.equal(result.segment.status, 'active');
  assert.equal(result.segment.liveSessionId, 'live-session-2');
});

test('rollover is idempotent for repeated request and rejects conflicting next segment', async () => {
  const repository = createMemoryMeetingRepository();
  const service = createService(repository);
  const { meeting, segment } = await service.createMeeting();
  const rollover = {
    idempotencyKey: 'rollover-1',
    checkpoint: checkpoint({ durableChunks: [chunk({ sequence: 1, text: 'hello' })] }),
    nextLiveSessionId: 'live-session-2'
  };

  const first = await service.rolloverSegment({ meetingId: meeting.id, segmentId: segment.id, rollover });
  const duplicate = await service.rolloverSegment({ meetingId: meeting.id, segmentId: segment.id, rollover });

  assert.equal(duplicate.segment.id, first.segment.id);
  assert.equal(duplicate.completedSegment.id, first.completedSegment.id);
  await assert.rejects(
    service.rolloverSegment({
      meetingId: meeting.id,
      segmentId: segment.id,
      rollover: { ...rollover, nextLiveSessionId: 'live-session-3' }
    }),
    /segment rollover conflict/
  );
});

test('rollover rejects non-active segments', async () => {
  const repository = createMemoryMeetingRepository();
  const service = createService(repository);
  const { meeting, segment } = await service.createMeeting();
  await repository.updateMeetingSegment(segment.fail({ endedAt: 2000, errorInfo: { reason: 'test' } }));

  await assert.rejects(
    service.rolloverSegment({
      meetingId: meeting.id,
      segmentId: segment.id,
      rollover: {
        idempotencyKey: 'rollover-1',
        checkpoint: checkpoint(),
        nextLiveSessionId: 'live-session-2'
      }
    }),
    /segment rollover requires an active segment/
  );
});

test('interrupted recovery marks current segment and creates next active segment', async () => {
  const repository = createMemoryMeetingRepository();
  const service = createService(repository);
  const { meeting, segment } = await service.createMeeting({ liveSessionId: 'live-session-1' });

  const result = await service.recoverSegment({
    meetingId: meeting.id,
    segmentId: segment.id,
    recovery: recovery({
      idempotencyKey: 'recover-1',
      checkpoint: checkpoint({ durableChunks: [chunk({ sequence: 1, text: 'hello' })] }),
      nextLiveSessionId: 'live-session-2',
      failureReason: 'token_expired',
      failureCategory: 'token',
      outcome: 'interrupted'
    })
  });

  assert.equal(result.interruptedSegment.status, 'interrupted');
  assert.equal(result.interruptedSegment.checkpoint.idempotencyKey, 'recover-1');
  assert.deepEqual(result.interruptedSegment.errorInfo, { reason: 'token_expired', category: 'token' });
  assert.equal(result.segment.id, 'segment-2');
  assert.equal(result.segment.sequence, 1);
  assert.equal(result.segment.status, 'active');
  assert.equal(result.segment.liveSessionId, 'live-session-2');
});

test('terminal interruption marks the meeting interrupted and creates a resumable segment', async () => {
  const repository = createMemoryMeetingRepository();
  const service = createService(repository);
  const { meeting, segment } = await service.createMeeting({ liveSessionId: 'live-session-1' });
  const recoveryInput = recovery({
    idempotencyKey: 'interrupt-1',
    checkpoint: checkpoint({ durableChunks: [chunk({ sequence: 1, text: 'hello' })] }),
    nextLiveSessionId: null,
    failureReason: 'unexpected_close',
    failureCategory: 'provider',
    outcome: 'interrupted'
  });

  const first = await service.recoverSegment({ meetingId: meeting.id, segmentId: segment.id, recovery: recoveryInput });
  const duplicate = await service.recoverSegment({ meetingId: meeting.id, segmentId: segment.id, recovery: recoveryInput });
  const storedMeeting = await repository.getMeeting(meeting.id);
  const segments = await repository.listMeetingSegments(meeting.id);

  assert.equal(first.meeting.status, 'interrupted');
  assert.equal(first.interruptedSegment.status, 'interrupted');
  assert.equal(first.segment.status, 'created');
  assert.equal(first.segment.liveSessionId, null);
  assert.equal(duplicate.segment.id, first.segment.id);
  assert.equal(storedMeeting.status, 'interrupted');
  assert.deepEqual(segments.map((item) => item.status), ['interrupted', 'created']);
});

test('completes an interrupted meeting and finalizes its empty resumable segment', async () => {
  const repository = createMemoryMeetingRepository();
  const service = createService(repository);
  const { meeting, segment } = await service.createMeeting({ liveSessionId: 'live-session-1' });
  await service.recoverSegment({
    meetingId: meeting.id,
    segmentId: segment.id,
    recovery: recovery({
      idempotencyKey: 'interrupt-complete-1',
      checkpoint: checkpoint({ durableChunks: [chunk({ sequence: 1, text: 'hello' })] }),
      nextLiveSessionId: null,
      outcome: 'interrupted'
    })
  });

  const result = await service.completeMeeting({ meetingId: meeting.id });
  const segments = await repository.listMeetingSegments(meeting.id);

  assert.equal(result.meeting.status, 'completed');
  assert.deepEqual(segments.map((item) => item.status), ['interrupted', 'completed']);
  assert.equal(segments[0].checkpoint.durableChunks.length, 1);
  assert.equal(segments[1].startedAt, 1000);
});

test('completes an active meeting and its current segment', async () => {
  const repository = createMemoryMeetingRepository();
  const service = createService(repository);
  const { meeting, segment } = await service.createMeeting({ liveSessionId: 'live-session-1' });

  const result = await service.completeMeeting({ meetingId: meeting.id });
  const segments = await repository.listMeetingSegments(meeting.id);

  assert.equal(result.meeting.status, 'completed');
  assert.equal(segments[0].id, segment.id);
  assert.equal(segments[0].status, 'completed');
  assert.equal(segments[0].endedAt, 1000);
  assert.equal(segments[0].liveSessionId, 'live-session-1');
});

test('failed recovery terminalizes current segment without creating next segment', async () => {
  const repository = createMemoryMeetingRepository();
  const service = createService(repository);
  const { meeting, segment } = await service.createMeeting({ liveSessionId: 'live-session-1' });

  const result = await service.recoverSegment({
    meetingId: meeting.id,
    segmentId: segment.id,
    recovery: recovery({
      idempotencyKey: 'recover-failed-1',
      checkpoint: checkpoint({ durableChunks: [chunk({ sequence: 1, text: 'hello' })] }),
      nextLiveSessionId: 'live-session-2',
      failureReason: 'auth_failed',
      failureCategory: 'token',
      outcome: 'failed'
    })
  });

  assert.equal(result.failedSegment.status, 'failed');
  assert.equal(result.failedSegment.checkpoint.idempotencyKey, 'recover-failed-1');
  assert.deepEqual(result.failedSegment.errorInfo, { reason: 'auth_failed', category: 'token' });
  assert.deepEqual(repository.listMeetingSegments(meeting.id).map((stored) => stored.id), ['segment-1']);
});

test('recovery is idempotent for repeated interrupted and failed requests', async () => {
  const interruptedRepository = createMemoryMeetingRepository();
  const interruptedService = createService(interruptedRepository);
  const interruptedStart = await interruptedService.createMeeting();
  const interruptedRecovery = recovery({
    idempotencyKey: 'recover-1',
    checkpoint: checkpoint({ durableChunks: [chunk({ sequence: 1, text: 'hello' })] }),
    nextLiveSessionId: 'live-session-2',
    failureReason: 'network_interrupted',
    failureCategory: 'network',
    outcome: 'interrupted'
  });

  const interruptedFirst = await interruptedService.recoverSegment({
    meetingId: interruptedStart.meeting.id,
    segmentId: interruptedStart.segment.id,
    recovery: interruptedRecovery
  });
  const interruptedDuplicate = await interruptedService.recoverSegment({
    meetingId: interruptedStart.meeting.id,
    segmentId: interruptedStart.segment.id,
    recovery: interruptedRecovery
  });

  assert.equal(interruptedDuplicate.interruptedSegment.id, interruptedFirst.interruptedSegment.id);
  assert.equal(interruptedDuplicate.segment.id, interruptedFirst.segment.id);

  const failedRepository = createMemoryMeetingRepository();
  const failedService = createService(failedRepository);
  const failedStart = await failedService.createMeeting();
  const failedRecovery = recovery({
    idempotencyKey: 'recover-failed-1',
    checkpoint: checkpoint(),
    nextLiveSessionId: 'live-session-2',
    failureReason: 'provider_error',
    failureCategory: 'provider',
    outcome: 'failed'
  });

  const failedFirst = await failedService.recoverSegment({
    meetingId: failedStart.meeting.id,
    segmentId: failedStart.segment.id,
    recovery: failedRecovery
  });
  const failedDuplicate = await failedService.recoverSegment({
    meetingId: failedStart.meeting.id,
    segmentId: failedStart.segment.id,
    recovery: failedRecovery
  });

  assert.equal(failedDuplicate.failedSegment.id, failedFirst.failedSegment.id);
});

test('recovery rejects conflicting repeated input', async () => {
  const repository = createMemoryMeetingRepository();
  const service = createService(repository);
  const { meeting, segment } = await service.createMeeting();
  const input = recovery({
    idempotencyKey: 'recover-1',
    checkpoint: checkpoint(),
    nextLiveSessionId: 'live-session-2',
    failureReason: 'network_interrupted',
    failureCategory: 'network',
    outcome: 'interrupted'
  });

  await service.recoverSegment({ meetingId: meeting.id, segmentId: segment.id, recovery: input });

  await assert.rejects(
    service.recoverSegment({
      meetingId: meeting.id,
      segmentId: segment.id,
      recovery: { ...input, nextLiveSessionId: 'live-session-3' }
    }),
    /segment recovery conflict/
  );
});

test('recovery rejects non-active segments', async () => {
  const repository = createMemoryMeetingRepository();
  const service = createService(repository);
  const { meeting, segment } = await service.createMeeting();
  await repository.updateMeetingSegment(segment.complete({ endedAt: 2000 }));

  await assert.rejects(
    service.recoverSegment({
      meetingId: meeting.id,
      segmentId: segment.id,
      recovery: recovery({
        idempotencyKey: 'recover-completed-1',
        checkpoint: checkpoint(),
        nextLiveSessionId: 'live-session-2',
        failureReason: 'unexpected_close',
        failureCategory: 'provider',
        outcome: 'interrupted'
      })
    }),
    /segment recovery requires an active segment/
  );
});

test('accelerated long meeting checkpoint scenario preserves 2+ hours of confirmed chunks', async () => {
  const repository = createMemoryMeetingRepository();
  const service = createService(repository);
  const scenario = await runLongMeetingCheckpointScenario({ service });
  const segments = repository.listMeetingSegments(scenario.meeting.id);
  const transcriptItems = transcriptItemsFromSegments({ meeting: scenario.meeting, segments });

  assert.equal(scenario.durationMs >= 2 * 60 * 60 * 1000, true);
  assert.equal(segments.length, 14);
  assert.deepEqual(
    countSegmentStatuses(segments),
    { active: 1, completed: 11, interrupted: 2 }
  );
  assert.deepEqual(
    segments
      .filter((segment) => segment.status === 'interrupted')
      .map((segment) => segment.errorInfo),
    [
      { reason: 'token_expired', category: 'token' },
      { reason: 'network_interrupted', category: 'network' }
    ]
  );
  assertNoMissingDuplicateOrOutOfOrderChunks(assert, transcriptItems, scenario.expectedChunks);
  assert.equal(
    reconstructChunkText(transcriptItems, 'source'),
    scenario.expectedChunks.filter((chunk) => chunk.stream === 'source').map((chunk) => chunk.text).join('\n')
  );
  assert.equal(
    reconstructChunkText(transcriptItems, 'translation'),
    scenario.expectedChunks.filter((chunk) => chunk.stream === 'translation').map((chunk) => chunk.text).join('\n')
  );
});

test('failed meeting segment keeps checkpoint content readable without failing the meeting record', async () => {
  const repository = createMemoryMeetingRepository();
  const service = createService(repository);
  const scenario = await runFailedSegmentCheckpointScenario({ service });
  const meeting = repository.getMeeting(scenario.meeting.id);
  const segments = repository.listMeetingSegments(scenario.meeting.id);
  const transcriptItems = transcriptItemsFromSegments({ meeting, segments });

  assert.equal(meeting.status, 'active');
  assert.equal(segments.length, 1);
  assert.equal(segments[0].status, 'failed');
  assert.deepEqual(segments[0].errorInfo, { reason: 'provider_error', category: 'provider' });
  assertNoMissingDuplicateOrOutOfOrderChunks(assert, transcriptItems, scenario.expectedChunks);
});

function createService(repository) {
  let meetingId = 0;
  let segmentId = 0;
  return createMeetingCheckpointService({
    meetingRepository: repository,
    idGenerator(prefix) {
      if (prefix === 'meeting') return `meeting-${++meetingId}`;
      if (prefix === 'segment') return `segment-${++segmentId}`;
      return `${prefix}-1`;
    },
    clock: () => 1000
  });
}

function checkpoint(overrides = {}) {
  return {
    idempotencyKey: overrides.idempotencyKey ?? 'checkpoint-1',
    durableChunks: overrides.durableChunks ?? [],
    ...(overrides.finalCues ? { finalCues: overrides.finalCues } : {}),
    pendingPartial: null
  };
}

function countSegmentStatuses(segments = []) {
  return segments.reduce((counts, segment) => {
    counts[segment.status] = (counts[segment.status] ?? 0) + 1;
    return counts;
  }, {});
}

function recovery(overrides = {}) {
  return {
    idempotencyKey: overrides.idempotencyKey ?? 'recover-1',
    checkpoint: overrides.checkpoint ?? checkpoint(),
    nextLiveSessionId: Object.hasOwn(overrides, 'nextLiveSessionId') ? overrides.nextLiveSessionId : 'live-session-2',
    failureReason: overrides.failureReason ?? 'unexpected_close',
    failureCategory: overrides.failureCategory ?? 'provider',
    outcome: overrides.outcome ?? 'interrupted'
  };
}

function chunk(overrides = {}) {
  const stream = overrides.stream ?? 'source';
  const sequence = overrides.sequence ?? 1;
  return {
    idempotencyKey: overrides.idempotencyKey ?? `chunk-${stream}-${sequence}`,
    meetingId: overrides.meetingId ?? 'meeting-1',
    segmentId: overrides.segmentId ?? 'segment-1',
    stream,
    sequence,
    text: overrides.text ?? 'text',
    timestamp: overrides.timestamp ?? 1000
  };
}

function finalCue(overrides = {}) {
  return {
    cueId: 'cue:session-1:segment-1:1',
    sessionId: 'session-1',
    segmentId: 'segment-1',
    sequence: 1,
    startTimeMs: 0,
    endTimeMs: 100,
    sourceLanguageCode: 'zh-Hant',
    targetLanguageCode: 'en',
    sourceText: '你好',
    translatedText: 'hello',
    status: 'final',
    finalizedReason: 'final',
    ...overrides
  };
}
