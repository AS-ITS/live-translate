import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalMeetingRecorder } from '../../src/lib/localMeetingRecorder.js';
import { createInMemoryLocalMeetingManifestStore } from '../../src/lib/localMeetingStorage.js';

function fakeChunkStore(files = new Map()) {
  return {
    async write(path, bytes) {
      files.set(path, bytes);
    },
    async read(path) {
      const value = files.get(path);
      if (!value) throw new Error(`Unknown local chunk file: ${path}.`);
      return value;
    },
    files
  };
}

function chunkInput(sequence, overrides = {}) {
  return {
    segmentId: 'segment-1',
    chunkId: `chunk-${sequence}`,
    sequence,
    startedAt: sequence * 10,
    endedAt: sequence * 10 + 9,
    byteSize: 1,
    checksum: `sha256:${sequence}`,
    ...overrides
  };
}

test('local recorder reserves, writes, and seals chunks before Stop', async () => {
  const manifestStore = createInMemoryLocalMeetingManifestStore();
  const chunkStore = fakeChunkStore();
  const recorder = createLocalMeetingRecorder({ manifestStore, chunkStore, now: () => 99 });

  assert.equal((await recorder.start('meeting-1')).state, 'capturing');
  await recorder.appendChunk(chunkInput(1), new Uint8Array([1]));
  await recorder.appendChunk(chunkInput(2), new Uint8Array([2]));
  const stopped = await recorder.stop({ finalSequence: 2 });

  assert.equal(stopped.state, 'stopped_local');
  assert.equal(stopped.meetingId, 'meeting-1');
  assert.notEqual(stopped.recordingId, stopped.meetingId);
  assert.equal(stopped.segmentId, `segment:${stopped.recordingId}:1`);
  assert.equal(stopped.captureEpoch, 1);
  assert.equal(stopped.providerEpoch, 0);
  assert.equal(stopped.finalSequence, 2);
  assert.equal(stopped.stopError, null);
  assert.equal((await manifestStore.list('meeting-1')).every((chunk) => chunk.state === 'sealed'), true);
});

test('local recorder traces reserve, OPFS write, seal, and failure identities', async () => {
  const manifestStore = createInMemoryLocalMeetingManifestStore();
  const chunkStore = fakeChunkStore();
  const events = [];
  const recorder = createLocalMeetingRecorder({
    manifestStore,
    chunkStore,
    onTrace: (event) => events.push(event)
  });
  await recorder.start('meeting-1', {
    recordingId: 'recording-1', segmentId: 'segment-1', operationId: 'start-1'
  });
  await recorder.appendChunk(chunkInput(1, {
    meetingId: 'meeting-1', recordingId: 'recording-1', chunkId: 'recording-1:audio-00000001'
  }), new Uint8Array([1]));
  await assert.rejects(
    recorder.appendChunk(chunkInput(1, {
      meetingId: 'meeting-1', recordingId: 'recording-1', chunkId: 'recording-1:audio-00000001', checksum: 'different'
    }), new Uint8Array([2])),
    (error) => error.code === 'local_chunk_identity_conflict'
  );

  assert.deepEqual(events.slice(0, 4).map((event) => event.stage), [
    'LOCAL_CHUNK_RESERVED',
    'LOCAL_CHUNK_WRITE_STARTED',
    'LOCAL_CHUNK_WRITE_SUCCEEDED',
    'LOCAL_CHUNK_SEALED'
  ]);
  assert.equal(events[0].recordingId, 'recording-1');
  assert.equal(events[0].segmentId, 'segment-1');
  assert.equal(events[0].chunkId, 'recording-1:audio-00000001');
  assert.equal(events.at(-1).stage, 'LOCAL_CHUNK_FAILED');
  assert.equal(events.at(-1).errorCode, 'local_chunk_identity_conflict');
});

test('Stop refuses to publish a final sequence with a missing chunk', async () => {
  const manifestStore = createInMemoryLocalMeetingManifestStore();
  const recorder = createLocalMeetingRecorder({ manifestStore, chunkStore: fakeChunkStore() });
  await recorder.start('meeting-1');
  await recorder.appendChunk(chunkInput(1), new Uint8Array([1]));

  await assert.rejects(
    recorder.stop({ finalSequence: 2 }),
    (error) => error.code === 'local_recorder_final_sequence_incomplete' && error.missingSequences[0] === 2
  );
  assert.equal(recorder.snapshot().state, 'stop_incomplete');
});

test('paused local recording can be finalized without resuming capture', async () => {
  const recorder = createLocalMeetingRecorder({ manifestStore: createInMemoryLocalMeetingManifestStore(), chunkStore: fakeChunkStore() });
  await recorder.start('meeting-1');
  await recorder.appendChunk(chunkInput(1), new Uint8Array([1]));
  await recorder.pause();

  const finalized = await recorder.finalize({ finalSequence: 1 });
  assert.equal(finalized.state, 'stopped_local');
  assert.equal(finalized.finalSequence, 1);
});

test('crash reconciliation seals a file written before manifest seal', async () => {
  const manifestStore = createInMemoryLocalMeetingManifestStore();
  const chunkStore = fakeChunkStore();
  const recorder = createLocalMeetingRecorder({ manifestStore, chunkStore });
  await recorder.start('meeting-1');
  const input = chunkInput(1);
  const reserved = await manifestStore.reserve({ ...input, meetingId: 'meeting-1' });
  chunkStore.files.set(reserved.path, new Uint8Array([1]));
  const result = await recorder.reconcile([{ path: reserved.path, byteSize: 1, checksum: input.checksum, endedAt: input.endedAt }]);

  assert.equal(result.chunks[0].state, 'sealed');
  assert.equal((await manifestStore.get('chunk-1')).state, 'sealed');
});

test('stop incomplete can retry after the missing chunk is reconciled', async () => {
  const manifestStore = createInMemoryLocalMeetingManifestStore();
  const recorder = createLocalMeetingRecorder({ manifestStore, chunkStore: fakeChunkStore() });
  await recorder.start('meeting-1');
  await recorder.appendChunk(chunkInput(1), new Uint8Array([1]));
  await assert.rejects(() => recorder.stop({ finalSequence: 2 }), (error) => error.code === 'local_recorder_final_sequence_incomplete');
  const missing = await manifestStore.reserve({ ...chunkInput(2), meetingId: 'meeting-1' });
  await manifestStore.seal(missing.chunkId, { byteSize: 1, checksum: 'sha256:2', endedAt: 20 });

  assert.equal((await recorder.stop({ finalSequence: 2 })).state, 'stopped_local');
});

test('finalized local recorder cannot restart', async () => {
  const recorder = createLocalMeetingRecorder({ manifestStore: createInMemoryLocalMeetingManifestStore(), chunkStore: fakeChunkStore() });
  await recorder.start('meeting-1');
  await recorder.stop({ finalSequence: 0 });

  await assert.rejects(() => recorder.start('meeting-1'), (error) => error.code === 'local_recorder_finalized');
});

test('local manifest keeps recording identity across continuation and provider epochs', async () => {
  const recorder = createLocalMeetingRecorder({ manifestStore: createInMemoryLocalMeetingManifestStore(), chunkStore: fakeChunkStore() });
  const started = await recorder.start('meeting-1', { operationId: 'start-1' });
  assert.deepEqual(await recorder.start('meeting-1', { operationId: 'start-1' }), started);
  const paused = await recorder.pause({ operationId: 'pause-1' });
  const resumed = await recorder.resume({ operationId: 'resume-1' });
  const reconnected = await recorder.providerReconnect({ operationId: 'provider-1' });
  assert.equal(paused.state, 'paused');
  assert.equal(resumed.recordingId, started.recordingId);
  assert.notEqual(resumed.segmentId, started.segmentId);
  assert.equal(reconnected.segmentId, resumed.segmentId);
  assert.equal(reconnected.providerEpoch, 1);
});

test('concurrent finalize shares completed result and rehydrated recorder rejects terminal recording', async () => {
  const manifestStore = createInMemoryLocalMeetingManifestStore();
  const recorder = createLocalMeetingRecorder({ manifestStore, chunkStore: fakeChunkStore() });
  await recorder.start('meeting-1');
  const [first, second] = await Promise.all([
    recorder.stop({ finalSequence: 0, operationId: 'final-1' }),
    recorder.stop({ finalSequence: 0, operationId: 'final-1' })
  ]);
  assert.deepEqual(first, second);
  assert.equal(first.state, 'stopped_local');
  const recovered = createLocalMeetingRecorder({ manifestStore, chunkStore: fakeChunkStore() });
  await assert.rejects(() => recovered.start('meeting-1'), (error) => error.code === 'local_recorder_finalized');
});

test('append is rejected after local Stop', async () => {
  const recorder = createLocalMeetingRecorder({
    manifestStore: createInMemoryLocalMeetingManifestStore(),
    chunkStore: fakeChunkStore()
  });
  await recorder.start('meeting-1');
  await recorder.stop({ finalSequence: 0 });
  await assert.rejects(() => recorder.appendChunk(chunkInput(1), new Uint8Array([1])), (error) => error.code === 'local_recorder_not_capturing');
});

test('recover and Finalize replay the same durable result after recorder reload', async () => {
  const manifestStore = createInMemoryLocalMeetingManifestStore();
  const first = createLocalMeetingRecorder({ manifestStore, chunkStore: fakeChunkStore() });
  await first.start('meeting-1', { operationId: 'start-1' });
  await first.pause({ operationId: 'pause-1' });
  const recovered = await first.recover({ operationId: 'recover-1' });

  const afterRecoverReload = createLocalMeetingRecorder({ manifestStore, chunkStore: fakeChunkStore() });
  await afterRecoverReload.restore('meeting-1');
  assert.deepEqual(await afterRecoverReload.recover({ operationId: 'recover-1' }), recovered);
  assert.equal(afterRecoverReload.snapshot().segmentId, recovered.segmentId);

  const finalized = await afterRecoverReload.finalize({ finalSequence: 0, operationId: 'finalize-1' });
  const afterFinalizeReload = createLocalMeetingRecorder({ manifestStore, chunkStore: fakeChunkStore() });
  await afterFinalizeReload.restore('meeting-1');
  assert.deepEqual(
    await afterFinalizeReload.finalize({ finalSequence: 0, operationId: 'finalize-1' }),
    finalized
  );
  await assert.rejects(
    () => afterFinalizeReload.start('meeting-1', { operationId: 'start-2' }),
    (error) => error.code === 'local_recorder_finalized'
  );
});

test('provider rollover changes only provider epoch and is idempotent', async () => {
  const recorder = createLocalMeetingRecorder({
    manifestStore: createInMemoryLocalMeetingManifestStore(),
    chunkStore: fakeChunkStore()
  });
  const started = await recorder.start('meeting-1', { operationId: 'start-1' });
  const rolled = await recorder.providerRollover({ operationId: 'rollover-1' });
  const replayed = await recorder.providerRollover({ operationId: 'rollover-1' });

  assert.equal(rolled.recordingId, started.recordingId);
  assert.equal(rolled.segmentId, started.segmentId);
  assert.equal(rolled.captureEpoch, started.captureEpoch);
  assert.equal(rolled.providerEpoch, started.providerEpoch + 1);
  assert.deepEqual(replayed, rolled);
});

test('local segment rollover keeps recording and capture identity while replaying one operation', async () => {
  const manifestStore = createInMemoryLocalMeetingManifestStore();
  const recorder = createLocalMeetingRecorder({ manifestStore, chunkStore: fakeChunkStore() });
  const started = await recorder.start('meeting-1', {
    operationId: 'start-1', recordingId: 'recording-1', segmentId: 'segment-1'
  });

  const rolled = await recorder.rolloverLocalSegment({ operationId: 'rollover-1', nextSegmentId: 'segment-2' });
  const replayed = await recorder.rolloverLocalSegment({ operationId: 'rollover-1', nextSegmentId: 'segment-untrusted' });

  assert.equal(rolled.recordingId, started.recordingId);
  assert.equal(rolled.segmentId, 'segment-2');
  assert.equal(rolled.captureEpoch, started.captureEpoch);
  assert.equal(rolled.providerEpoch, started.providerEpoch + 1);
  assert.deepEqual(replayed, rolled);
});

test('successful Finalize clears stale stop error and replays the clean result', async () => {
  const manifestStore = createInMemoryLocalMeetingManifestStore();
  const recorder = createLocalMeetingRecorder({ manifestStore, chunkStore: fakeChunkStore() });
  await recorder.start('meeting-1');
  await recorder.appendChunk(chunkInput(1), new Uint8Array([1]));
  await assert.rejects(
    () => recorder.finalize({ finalSequence: 2, operationId: 'failed-finalize' }),
    (error) => error.code === 'local_recorder_final_sequence_incomplete'
  );
  const missing = await manifestStore.reserve({ ...chunkInput(2), meetingId: 'meeting-1' });
  await manifestStore.seal(missing.chunkId, { byteSize: 1, checksum: 'sha256:2', endedAt: 20 });

  const finalized = await recorder.finalize({ finalSequence: 2, operationId: 'finalize-1' });
  assert.equal(finalized.stopError, null);
  assert.deepEqual(
    await recorder.finalize({ finalSequence: 2, operationId: 'finalize-1' }),
    finalized
  );
});

test('parallel duplicate append performs one chunk write and rejects identity conflicts', async () => {
  const manifestStore = createInMemoryLocalMeetingManifestStore();
  let writeCount = 0;
  let storedBytes = null;
  const chunkStore = {
    async write(_path, bytes) {
      writeCount += 1;
      storedBytes = bytes;
    },
    async read() {
      return storedBytes;
    }
  };
  const recorder = createLocalMeetingRecorder({ manifestStore, chunkStore });
  await recorder.start('meeting-1');
  const input = chunkInput(1);

  const [first, duplicate] = await Promise.all([
    recorder.appendChunk(input, new Uint8Array([1])),
    recorder.appendChunk(input, new Uint8Array([1]))
  ]);

  assert.equal(writeCount, 1);
  assert.deepEqual(duplicate, first);
  await assert.rejects(
    () => recorder.appendChunk({ ...input, checksum: 'sha256:different' }, new Uint8Array([2])),
    (error) => error.code === 'local_chunk_identity_conflict'
  );
  assert.equal(writeCount, 1);
});
