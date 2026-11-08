import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkpointChunksForTranscriptItems,
  createMeetingCheckpointSyncCoordinator
} from '../../src/lib/meetingCheckpointSyncCoordinator.js';

function committed(payload) {
  return {
    meetingId: payload.meetingId,
    segmentId: payload.segmentId,
    checkpoint: {
      durableChunks: payload.durableChunks,
      finalCues: payload.finalCues,
      cueCheckpoint: payload.cueCheckpoint
    }
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((finish) => { resolve = finish; });
  return { promise, resolve };
}

test('flush barrier waits for a chunk enqueued during the first durable ACK', async () => {
  const firstEntered = deferred();
  const releaseFirst = deferred();
  const secondEntered = deferred();
  const releaseSecond = deferred();
  const calls = [];
  const coordinator = createMeetingCheckpointSyncCoordinator({
    updateCheckpoint: async (payload) => {
      calls.push(payload);
      if (calls.length === 1) {
        firstEntered.resolve();
        await releaseFirst.promise;
      } else if (calls.length === 2) {
        secondEntered.resolve();
        await releaseSecond.promise;
      }
      return committed(payload);
    },
    setTimeoutFn: () => 1,
    clearTimeoutFn: () => {}
  });
  coordinator.start({ meetingId: 'meeting-1', segmentId: 'segment-1' });
  coordinator.enqueue([chunk({ idempotencyKey: 'chunk-a', sequence: 1 })]);
  const barrier = coordinator.flush();
  await firstEntered.promise;
  coordinator.enqueue([chunk({ idempotencyKey: 'chunk-b', sequence: 2 })]);
  releaseFirst.resolve();
  await secondEntered.promise;

  let settled = false;
  void barrier.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.deepEqual(calls.map((call) => call.durableChunks.map((item) => item.idempotencyKey)),
    [['chunk-a'], ['chunk-b']]);

  releaseSecond.resolve();
  assert.equal(await barrier, true);
  assert.equal(await coordinator.flush(), true);
  assert.equal(calls.length, 2, 'a repeated flush must not write acknowledged chunks again');
});

test('flush barrier reports failure when a later chunk write fails', async () => {
  const firstEntered = deferred();
  const releaseFirst = deferred();
  const calls = [];
  const coordinator = createMeetingCheckpointSyncCoordinator({
    updateCheckpoint: async (payload) => {
      calls.push(payload);
      if (calls.length === 1) {
        firstEntered.resolve();
        await releaseFirst.promise;
      }
      if (calls.length === 2) throw new Error('IndexedDB transaction failed');
      return committed(payload);
    },
    setTimeoutFn: () => 1,
    clearTimeoutFn: () => {}
  });
  coordinator.start({ meetingId: 'meeting-1', segmentId: 'segment-1' });
  coordinator.enqueue([chunk({ idempotencyKey: 'chunk-a', sequence: 1 })]);
  const barrier = coordinator.flush();
  await firstEntered.promise;
  coordinator.enqueue([chunk({ idempotencyKey: 'chunk-b', sequence: 2 })]);
  releaseFirst.resolve();

  assert.equal(await barrier, false);
  assert.equal(await coordinator.flush(), true);
  assert.deepEqual(calls.map((call) => call.durableChunks.map((item) => item.idempotencyKey)),
    [['chunk-a'], ['chunk-b'], ['chunk-b']]);
});

test('flush barrier stops after a bounded number of new pending batches', async () => {
  let writes = 0;
  let coordinator;
  coordinator = createMeetingCheckpointSyncCoordinator({
    updateCheckpoint: async (payload) => {
      writes += 1;
      coordinator.enqueue([chunk({ idempotencyKey: `chunk-${writes + 1}`, sequence: writes + 1 })]);
      return committed(payload);
    },
    setTimeoutFn: () => 1,
    clearTimeoutFn: () => {}
  });
  coordinator.start({ meetingId: 'meeting-1', segmentId: 'segment-1' });
  coordinator.enqueue([chunk({ idempotencyKey: 'chunk-1', sequence: 1 })]);

  assert.equal(await coordinator.flush(), false);
  assert.equal(writes, 3);
});

test('checkpoint flush requires a durable ACK before clearing a pending Cue', async () => {
  const calls = [];
  const failures = [];
  const responses = [
    () => undefined,
    (payload) => ({ checkpoint: committed(payload).checkpoint }),
    (payload) => ({ ...committed(payload), segmentId: 'other-segment' }),
    (payload) => ({ ...committed(payload), checkpoint: {
      ...committed(payload).checkpoint,
      cueCheckpoint: { nextSequence: 1 }
    } })
  ];
  const coordinator = createMeetingCheckpointSyncCoordinator({
    updateCheckpoint: async (payload) => {
      calls.push(payload);
      return calls.length <= responses.length ? responses[calls.length - 1](payload) : committed(payload);
    },
    onError: (error) => failures.push(error),
    setTimeoutFn: () => 1,
    clearTimeoutFn: () => {}
  });
  coordinator.start({ meetingId: 'meeting-1', segmentId: 'segment-1' });
  coordinator.enqueueCues([{ cueId: 'cue-1', sessionId: 'session-1', segmentId: 'segment-1', status: 'final', sequence: 1 }], { nextSequence: 2 });

  for (let attempt = 0; attempt < 4; attempt += 1) {
    assert.equal(await coordinator.flush(), false);
    assert.deepEqual(calls.at(-1).finalCues.map((cue) => cue.cueId), ['cue-1']);
    assert.equal(calls.at(-1).cueCheckpoint.nextSequence, 2);
  }
  assert.equal(await coordinator.flush(), true);
  assert.equal(await coordinator.flush(), true);
  assert.equal(calls.length, 5);
  assert.equal(new Set(calls.map((call) => call.idempotencyKey)).size, 1);
  assert.equal(failures.length, 4);
  assert.ok(failures.every((error) => error.code === 'checkpoint_conflict'));
});

test('meeting checkpoint sync coordinator batches scheduled chunks', async () => {
  const calls = [];
  const timers = [];
  const statuses = [];
  const coordinator = createMeetingCheckpointSyncCoordinator({
    updateCheckpoint: async (payload) => { calls.push(payload); return committed(payload); },
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
      return committed(payload);
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
      return committed(payload);
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
      return committed(payload);
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
    updateCheckpoint: async (payload) => { calls.push(payload); return committed(payload); },
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

test('queued flush keeps its original segment ownership after a new segment starts', async () => {
  const calls = [];
  let resolveFirstUpdate;
  const firstUpdate = new Promise((resolve) => { resolveFirstUpdate = resolve; });
  const coordinator = createMeetingCheckpointSyncCoordinator({
    updateCheckpoint: async (payload) => {
      calls.push(payload);
      if (calls.length === 1) await firstUpdate;
      return committed(payload);
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
  assert.equal(await oldFlush, false, 'a replaced generation cannot satisfy the old barrier');
  await coordinator.flush();

  assert.equal(calls.length, 2);
  assert.equal(calls[0].segmentId, 'segment-1');
  assert.deepEqual(calls[0].durableChunks.map((item) => item.idempotencyKey), ['old']);
  assert.equal(calls[1].segmentId, 'segment-2');
  assert.deepEqual(calls[1].durableChunks.map((item) => item.idempotencyKey), ['new']);
});

test('pending retry remains owned by segment A while new operations use segment B', async () => {
  const calls = [];
  const retryTimers = [];
  let failSegmentA = true;
  const coordinator = createMeetingCheckpointSyncCoordinator({
    updateCheckpoint: async (payload) => {
      calls.push(payload);
      if (payload.segmentId === 'segment-a' && failSegmentA) {
        const error = new Error('temporary checkpoint failure');
        error.status = 503;
        throw error;
      }
      return committed(payload);
    },
    delayMs: 0,
    retryDelayMs: 10,
    setTimeoutFn: (callback, delayMs) => {
      retryTimers.push({ callback, delayMs });
      return callback;
    },
    clearTimeoutFn: () => {}
  });

  coordinator.start({ meetingId: 'meeting-1', segmentId: 'segment-a' });
  coordinator.enqueueCues([{ cueId: 'cue-a', sessionId: 'session-1', segmentId: 'segment-a', status: 'final', sequence: 1 }]);
  assert.equal(await coordinator.flush(), false);

  coordinator.start({ meetingId: 'meeting-1', segmentId: 'segment-b' });
  coordinator.enqueueCues([{ cueId: 'cue-b', sessionId: 'session-1', segmentId: 'segment-b', status: 'final', sequence: 2 }]);
  assert.equal(await coordinator.flush(), true);

  failSegmentA = false;
  retryTimers.find((timer) => timer.delayMs === 10).callback();
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(calls.map(({ segmentId, finalCues }) => ({
    segmentId,
    cueIds: finalCues.map((cue) => cue.cueId)
  })), [
    { segmentId: 'segment-a', cueIds: ['cue-a'] },
    { segmentId: 'segment-b', cueIds: ['cue-b'] },
    { segmentId: 'segment-a', cueIds: ['cue-a'] }
  ]);
});

test('four consecutive segment scopes never mix cue ownership', async () => {
  const calls = [];
  const coordinator = createMeetingCheckpointSyncCoordinator({
    updateCheckpoint: async (payload) => { calls.push(payload); return committed(payload); },
    setTimeoutFn: () => {},
    clearTimeoutFn: () => {}
  });

  for (let index = 1; index <= 4; index += 1) {
    const segmentId = `segment-${index}`;
    coordinator.start({ meetingId: 'meeting-1', segmentId });
    coordinator.enqueueCues([
      { cueId: `cue-${index}-1`, sessionId: 'session-1', segmentId, status: 'final', sequence: index * 2 - 1 },
      { cueId: `cue-${index}-2`, sessionId: 'session-1', segmentId, status: 'final', sequence: index * 2 }
    ]);
    assert.equal(await coordinator.flush(), true);
  }

  assert.deepEqual(calls.map(({ segmentId, finalCues }) => ({
    segmentId,
    ownedSegments: [...new Set(finalCues.map((cue) => cue.segmentId))]
  })), Array.from({ length: 4 }, (_, index) => ({
    segmentId: `segment-${index + 1}`,
    ownedSegments: [`segment-${index + 1}`]
  })));
});

test('segment filtering keeps old chunks and cues out of the current payload', async () => {
  const calls = [];
  const coordinator = createMeetingCheckpointSyncCoordinator({
    updateCheckpoint: async (payload) => { calls.push(payload); return committed(payload); },
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
    updateCheckpoint: async (payload) => { calls.push(payload); return committed(payload); },
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

test('failed flush retries and accepts a newer corrected Cue ACK', async () => {
  const previous = { cueId: 'cue-1', sessionId: 'session-1', segmentId: 'segment-1',
    sequence: 1, revision: 7, startTimeMs: 0, endTimeMs: 100,
    sourceLanguageCode: 'en', targetLanguageCode: 'zh-Hant', sourceText: 'old source',
    translatedText: 'translation', sourceVersion: 3, translationVersion: 3,
    status: 'final', finalizedReason: 'merged', audioTurnId: 'turn-1', providerEventSequence: 7,
    sourceProvenance: { audioTurnId: 'turn-1', connectionEpoch: 1, providerEpoch: 1, eventSequence: 7 } };
  const newer = { ...previous, revision: 15, sourceText: 'corrected source', sourceVersion: 6,
    providerEventSequence: 15,
    sourceProvenance: { audioTurnId: 'turn-1', connectionEpoch: 1, providerEpoch: 1, eventSequence: 15 } };
  let calls = 0;
  const coordinator = createMeetingCheckpointSyncCoordinator({
    updateCheckpoint: async (payload) => {
      calls += 1;
      if (calls === 1) {
        const error = new Error('temporary write failure');
        error.status = 503;
        throw error;
      }
      return committed({ ...payload, finalCues: [newer] });
    },
    onDiagnostic: () => {}, setTimeoutFn: () => 1, clearTimeoutFn: () => {}
  });
  coordinator.start({ meetingId: 'meeting-1', segmentId: 'segment-1' });
  coordinator.enqueueCues([previous]);
  assert.equal(await coordinator.flush(), false);
  assert.equal(await coordinator.flush(), true);
  assert.equal(await coordinator.flush(), true);
  assert.equal(calls, 2);
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
