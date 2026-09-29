import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalMeetingRecorder } from '../../src/lib/localMeetingRecorder.js';
import { createInMemoryLocalMeetingManifestStore } from '../../src/lib/localMeetingStorage.js';

function fakeChunkStore(files = new Map()) {
  return {
    async write(path, bytes) {
      files.set(path, bytes);
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

  assert.equal(recorder.start('meeting-1').state, 'capturing');
  await recorder.appendChunk(chunkInput(1), new Uint8Array([1]));
  await recorder.appendChunk(chunkInput(2), new Uint8Array([2]));
  const stopped = await recorder.stop({ finalSequence: 2 });

  assert.equal(stopped.state, 'stopped_local');
  assert.equal(stopped.meetingId, 'meeting-1');
  assert.equal(stopped.recordingId, 'recording:meeting-1');
  assert.equal(stopped.segmentId, 'segment:recording:meeting-1:1');
  assert.equal(stopped.captureEpoch, 1);
  assert.equal(stopped.providerEpoch, 0);
  assert.equal(stopped.finalSequence, 2);
  assert.equal(stopped.stopError, null);
  assert.equal((await manifestStore.list('meeting-1')).every((chunk) => chunk.state === 'sealed'), true);
});

test('Stop refuses to publish a final sequence with a missing chunk', async () => {
  const manifestStore = createInMemoryLocalMeetingManifestStore();
  const recorder = createLocalMeetingRecorder({ manifestStore, chunkStore: fakeChunkStore() });
  recorder.start('meeting-1');
  await recorder.appendChunk(chunkInput(1), new Uint8Array([1]));

  await assert.rejects(
    recorder.stop({ finalSequence: 2 }),
    (error) => error.code === 'local_recorder_final_sequence_incomplete' && error.missingSequences[0] === 2
  );
  assert.equal(recorder.snapshot().state, 'stop_incomplete');
});

test('crash reconciliation seals a file written before manifest seal', async () => {
  const manifestStore = createInMemoryLocalMeetingManifestStore();
  const chunkStore = fakeChunkStore();
  const recorder = createLocalMeetingRecorder({ manifestStore, chunkStore });
  recorder.start('meeting-1');
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
  recorder.start('meeting-1');
  await recorder.appendChunk(chunkInput(1), new Uint8Array([1]));
  await assert.rejects(() => recorder.stop({ finalSequence: 2 }), (error) => error.code === 'local_recorder_final_sequence_incomplete');
  const missing = await manifestStore.reserve({ ...chunkInput(2), meetingId: 'meeting-1' });
  await manifestStore.seal(missing.chunkId, { byteSize: 1, checksum: 'sha256:2', endedAt: 20 });

  assert.equal((await recorder.stop({ finalSequence: 2 })).state, 'stopped_local');
});

test('finalized local recorder cannot restart', async () => {
  const recorder = createLocalMeetingRecorder({ manifestStore: createInMemoryLocalMeetingManifestStore(), chunkStore: fakeChunkStore() });
  recorder.start('meeting-1');
  await recorder.stop({ finalSequence: 0 });

  assert.throws(() => recorder.start('meeting-1'), (error) => error.code === 'local_recorder_finalized');
});

test('local manifest keeps recording identity across continuation and provider epochs', () => {
  const recorder = createLocalMeetingRecorder({ manifestStore: createInMemoryLocalMeetingManifestStore(), chunkStore: fakeChunkStore() });
  const started = recorder.start('meeting-1', { operationId: 'start-1' });
  assert.deepEqual(recorder.start('meeting-1', { operationId: 'start-1' }), started);
  const paused = recorder.pause({ operationId: 'pause-1' });
  const resumed = recorder.resume({ operationId: 'resume-1' });
  const reconnected = recorder.providerReconnect({ operationId: 'provider-1' });
  assert.equal(paused.state, 'paused');
  assert.equal(resumed.recordingId, started.recordingId);
  assert.notEqual(resumed.segmentId, started.segmentId);
  assert.equal(reconnected.segmentId, resumed.segmentId);
  assert.equal(reconnected.providerEpoch, 1);
});

test('concurrent finalize shares completed result and rehydrated recorder rejects terminal recording', async () => {
  const manifestStore = createInMemoryLocalMeetingManifestStore();
  const recorder = createLocalMeetingRecorder({ manifestStore, chunkStore: fakeChunkStore() });
  recorder.start('meeting-1');
  const [first, second] = await Promise.all([
    recorder.stop({ finalSequence: 0, operationId: 'final-1' }),
    recorder.stop({ finalSequence: 0, operationId: 'final-1' })
  ]);
  assert.deepEqual(first, second);
  assert.equal(first.state, 'stopped_local');
  const recovered = createLocalMeetingRecorder({ manifestStore, chunkStore: fakeChunkStore() });
  assert.throws(() => recovered.start('meeting-1'), (error) => error.code === 'local_recorder_finalized');
});

test('append is rejected after local Stop', async () => {
  const recorder = createLocalMeetingRecorder({
    manifestStore: createInMemoryLocalMeetingManifestStore(),
    chunkStore: fakeChunkStore()
  });
  recorder.start('meeting-1');
  await recorder.stop({ finalSequence: 0 });
  await assert.rejects(() => recorder.appendChunk(chunkInput(1), new Uint8Array([1])), (error) => error.code === 'local_recorder_not_capturing');
});
