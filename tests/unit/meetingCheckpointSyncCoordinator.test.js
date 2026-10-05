import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkpointChunksForTranscriptItems,
  createMeetingCheckpointSyncCoordinator
} from '../../src/lib/meetingCheckpointSyncCoordinator.js';

test('meeting checkpoint sync coordinator batches scheduled chunks', async () => {
  const calls = [];
  const timers = [];
  const statuses = [];
  const coordinator = createMeetingCheckpointSyncCoordinator({
    updateCheckpoint: async (payload) => calls.push(payload),
    onStatusChange: (status) => statuses.push(status),
    setTimeoutFn: (callback) => {
      timers.push(callback);
      return callback;
    },
    clearTimeoutFn: () => {}
  });

  coordinator.start({ meetingId: 'meeting-1', segmentId: 'segment-1' });
  coordinator.enqueue([
    chunk({ idempotencyKey: 'chunk-translation-1', stream: 'translation', sequence: 1 }),
    chunk({ idempotencyKey: 'chunk-source-0', stream: 'source', sequence: 0 })
  ]);

  assert.equal(timers.length, 1);
  assert.deepEqual(calls, []);

  timers[0]();
  await coordinator.flush();

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].durableChunks.map(({ stream, sequence }) => ({ stream, sequence })), [
    { stream: 'source', sequence: 0 },
    { stream: 'translation', sequence: 1 }
  ]);
  assert.deepEqual(statuses, ['ready', 'syncing', 'synced']);
});

test('meeting checkpoint sync coordinator retains chunks after failure and retries', async () => {
  const calls = [];
  const errors = [];
  let shouldFail = true;
  const coordinator = createMeetingCheckpointSyncCoordinator({
    updateCheckpoint: async (payload) => {
      calls.push(payload);
      if (shouldFail) throw new Error('checkpoint failed');
    },
    onError: (error) => errors.push(error.message),
    setTimeoutFn: () => {},
    clearTimeoutFn: () => {}
  });

  coordinator.start({ meetingId: 'meeting-1', segmentId: 'segment-1' });
  coordinator.enqueue([chunk()]);

  assert.equal(await coordinator.flush(), false);
  shouldFail = false;
  assert.equal(await coordinator.flush(), true);

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].durableChunks, calls[1].durableChunks);
  assert.deepEqual(errors, ['checkpoint failed']);
});

test('meeting checkpoint sync coordinator reconciles a conflict with the latest checkpoint', async () => {
  const calls = [];
  const errors = [];
  let latestCheckpointCalls = 0;
  let shouldConflict = true;
  const coordinator = createMeetingCheckpointSyncCoordinator({
    updateCheckpoint: async (payload) => {
      calls.push(payload);
      if (shouldConflict) {
        shouldConflict = false;
        const error = new Error('checkpoint conflict');
        error.status = 409;
        throw error;
      }
    },
    getCheckpoint: async () => {
      latestCheckpointCalls += 1;
      return {
        checkpoint: {
          durableChunks: [chunk({ text: 'already saved' })],
          finalCues: [],
          cueCheckpoint: null
        }
      };
    },
    onError: (error) => errors.push(error.message),
    setTimeoutFn: () => {},
    clearTimeoutFn: () => {}
  });

  coordinator.start({ meetingId: 'meeting-1', segmentId: 'segment-1' });
  coordinator.enqueue([chunk()]);

  assert.equal(await coordinator.flush(), false);
  assert.equal(latestCheckpointCalls, 1);
  assert.deepEqual(errors, []);

  assert.equal(await coordinator.flush(), true);
  assert.equal(calls.length, 2);
});

test('meeting checkpoint sync coordinator retries transient failures in the background', async () => {
  const calls = [];
  const timers = [];
  let failuresRemaining = 1;
  const coordinator = createMeetingCheckpointSyncCoordinator({
    updateCheckpoint: async (payload) => {
      calls.push(payload);
      if (failuresRemaining > 0) {
        failuresRemaining -= 1;
        const error = new Error('temporarily unavailable');
        error.status = 503;
        throw error;
      }
    },
    delayMs: 0,
    retryDelayMs: 10,
    setTimeoutFn: (callback) => {
      timers.push(callback);
      return callback;
    },
    clearTimeoutFn: (timer) => {
      const index = timers.indexOf(timer);
      if (index >= 0) timers.splice(index, 1);
    }
  });

  coordinator.start({ meetingId: 'meeting-1', segmentId: 'segment-1' });
  coordinator.enqueue([chunk()]);
  await coordinator.flush();

  assert.equal(calls.length, 1);
  assert.equal(timers.length, 1);
  timers.shift()();
  await coordinator.flush();

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].durableChunks, calls[1].durableChunks);
});

test('meeting checkpoint sync coordinator flushes immediately on stop', async () => {
  const calls = [];
  const clearedTimers = [];
  const coordinator = createMeetingCheckpointSyncCoordinator({
    updateCheckpoint: async (payload) => calls.push(payload),
    delayMs: 5000,
    setTimeoutFn: (callback) => callback,
    clearTimeoutFn: (timer) => clearedTimers.push(timer)
  });

  coordinator.start({ meetingId: 'meeting-1', segmentId: 'segment-1' });
  coordinator.enqueue([chunk()]);
  await coordinator.flush();

  assert.equal(clearedTimers.length, 1);
  assert.equal(calls.length, 1);
});

test('queued flush from an old segment is ignored after a new segment starts', async () => {
  const calls = [];
  let resolveFirstUpdate;
  const firstUpdate = new Promise((resolve) => { resolveFirstUpdate = resolve; });
  const coordinator = createMeetingCheckpointSyncCoordinator({
    updateCheckpoint: async (payload) => {
      calls.push(payload);
      if (calls.length === 1) await firstUpdate;
    },
    delayMs: 0,
    setTimeoutFn: (callback) => callback,
    clearTimeoutFn: () => {}
  });

  coordinator.start({ meetingId: 'meeting-1', segmentId: 'segment-1' });
  coordinator.enqueue([chunk({ idempotencyKey: 'old', segmentId: 'segment-1' })]);
  const oldFlush = coordinator.flush();
  coordinator.start({ meetingId: 'meeting-1', segmentId: 'segment-2' });
  coordinator.enqueue([chunk({ idempotencyKey: 'new', segmentId: 'segment-2', text: 'new' })]);
  resolveFirstUpdate();
  await oldFlush;
  await coordinator.flush();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].segmentId, 'segment-2');
  assert.deepEqual(calls[0].durableChunks.map((item) => item.idempotencyKey), ['new']);
});

test('segment filtering keeps old chunks and cues out of the current payload', async () => {
  const calls = [];
  const coordinator = createMeetingCheckpointSyncCoordinator({
    updateCheckpoint: async (payload) => calls.push(payload),
    setTimeoutFn: () => {},
    clearTimeoutFn: () => {}
  });

  coordinator.start({ meetingId: 'meeting-1', segmentId: 'segment-1' });
  coordinator.enqueue([chunk({ idempotencyKey: 'old', segmentId: 'segment-1' })]);
  coordinator.enqueueCues([{ cueId: 'old-cue', segmentId: 'segment-1', status: 'final', sequence: 0 }], { nextSequence: 1 });
  coordinator.start({ meetingId: 'meeting-1', segmentId: 'segment-2' });
  coordinator.enqueue([chunk({ idempotencyKey: 'new', segmentId: 'segment-2', text: 'new' })]);
  coordinator.enqueueCues([{ cueId: 'new-cue', segmentId: 'segment-2', status: 'final', sequence: 0 }], { nextSequence: 2 });

  await coordinator.flush();

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].durableChunks.map((item) => item.segmentId), ['segment-2']);
  assert.deepEqual(calls[0].finalCues.map((item) => item.segmentId), ['segment-2']);
  assert.deepEqual(calls[0].cueCheckpoint, { nextSequence: 2 });
});

test('checkpoint queue keeps the newer refinement for the same cueId', async () => {
  const calls = [];
  const coordinator = createMeetingCheckpointSyncCoordinator({
    updateCheckpoint: async (payload) => calls.push(payload),
    setTimeoutFn: () => {},
    clearTimeoutFn: () => {}
  });
  coordinator.start({ meetingId: 'meeting-1', segmentId: 'segment-1' });
  const base = { cueId: 'cue-1', sessionId: 'session-1', segmentId: 'segment-1', status: 'final', sequence: 1 };
  coordinator.enqueueCues([{ ...base, refinement: { status: 'completed', version: 1 }, refinedTranslation: 'revised' }]);
  coordinator.enqueueCues([{ ...base, refinement: { status: 'pending', version: 1 } }]);

  await coordinator.flush();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].finalCues.length, 1);
  assert.equal(calls[0].finalCues[0].refinement.status, 'completed');
  assert.equal(calls[0].finalCues[0].refinedTranslation, 'revised');
});

test('checkpointChunksForTranscriptItems maps final transcript items only', () => {
  const chunks = checkpointChunksForTranscriptItems({
    meetingId: 'meeting-1',
    segmentId: 'segment-1',
    transcriptItems: [
      { id: 'source-1', stream: 'source', status: 'final', sequence: 0, text: 'hello', startedAt: 1000, finalizedAt: 1200 },
      { id: 'source-2', stream: 'source', status: 'partial', sequence: 1, text: 'draft', startedAt: 1300 },
      { id: 'translation-1', stream: 'translation', status: 'final', sequence: 0, text: 'world', startedAt: 1000 }
    ]
  });

  assert.deepEqual(chunks, [
    {
      idempotencyKey: 'checkpoint:segment-1:source-1',
      meetingId: 'meeting-1',
      segmentId: 'segment-1',
      stream: 'source',
      sequence: 0,
      text: 'hello',
      timestamp: 1200
    },
    {
      idempotencyKey: 'checkpoint:segment-1:translation-1',
      meetingId: 'meeting-1',
      segmentId: 'segment-1',
      stream: 'translation',
      sequence: 0,
      text: 'world',
      timestamp: 1000
    }
  ]);
});

function chunk(overrides = {}) {
  return {
    idempotencyKey: overrides.idempotencyKey ?? 'chunk-source-0',
    meetingId: overrides.meetingId ?? 'meeting-1',
    segmentId: overrides.segmentId ?? 'segment-1',
    stream: overrides.stream ?? 'source',
    sequence: overrides.sequence ?? 0,
    text: overrides.text ?? 'hello',
    timestamp: overrides.timestamp ?? 1000
  };
}
