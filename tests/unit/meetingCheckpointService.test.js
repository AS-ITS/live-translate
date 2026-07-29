import assert from 'node:assert/strict';
import test from 'node:test';
import { createMeetingCheckpointService } from '../../src/application/meetingCheckpointService.js';
import { createMemoryMeetingRepository } from '../../src/infrastructure/meetingRepositoryAdapter.js';

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
    pendingPartial: null
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
