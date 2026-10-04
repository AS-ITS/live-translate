import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalMeetingPersistence } from '../../src/lib/localMeetingPersistence.js';
import { createInMemoryLocalMeetingManifestStore } from '../../src/lib/localMeetingStorage.js';

function fakeChunkStore() {
  const files = new Map();
  return {
    files,
    async write(path, bytes) { files.set(path, new Uint8Array(bytes)); },
    async read(path) { return new Blob([files.get(path)]); }
  };
}

function fakeCrypto() {
  return { subtle: { async digest(_algorithm, bytes) { return new Uint8Array([bytes.byteLength, 1, 2, 3]).buffer; } } };
}

function operationIds() {
  let value = 0;
  return (type) => `${type}:${++value}`;
}

async function concatenateTestArtifact({ chunks, readChunk }) {
  const parts = await Promise.all(chunks.map((chunk) => readChunk(chunk.path)));
  return {
    blob: new Blob(parts, { type: 'audio/webm' }),
    mimeType: 'audio/webm',
    extension: 'webm',
    captureSegmentCount: new Set(chunks.map((chunk) => chunk.segmentId)).size,
    chunkIds: chunks.map((chunk) => chunk.chunkId)
  };
}

test('production local persistence keeps audio, cues, and checkpoints together', async () => {
  const manifestStore = createInMemoryLocalMeetingManifestStore();
  const persistence = createLocalMeetingPersistence({
    manifestStore,
    chunkStore: fakeChunkStore(),
    cryptoImpl: fakeCrypto(),
    createOperationId: operationIds(),
    composeAudioArtifact: concatenateTestArtifact
  });
  await persistence.start({ meetingId: 'meeting-1', recordingId: 'session-1', segmentId: 'segment-1' });
  await persistence.appendAudioChunk({ data: new Blob(['one'], { type: 'audio/webm' }), mimeType: 'audio/webm', receivedAt: 10 });
  await persistence.saveCue({
    meetingId: 'meeting-1', sessionId: 'session-1', segmentId: 'segment-1',
    cue: { cueId: 'cue-1', sequence: 1, sourceText: 'hello' }, producedAt: 11
  });
  await persistence.updateCheckpoint({
    meetingId: 'meeting-1', segmentId: 'segment-1', durableChunks: [],
    finalCues: [{ cueId: 'cue-1', sequence: 1 }], cueCheckpoint: { nextSequence: 2 }
  });
  await persistence.pause();
  await persistence.resume();
  await persistence.providerReconnect();
  await persistence.providerRollover();
  await persistence.appendAudioChunk({ data: new Blob(['two'], { type: 'audio/webm' }), mimeType: 'audio/webm', receivedAt: 20 });

  const audio = await persistence.finalizeAudio({ fileName: 'meeting-1.webm' });
  const restored = await persistence.restore('meeting-1');
  const checkpoint = await persistence.getCheckpoint({ meetingId: 'meeting-1', segmentId: 'segment-1' });
  assert.equal(audio.status, 'ready');
  assert.equal(await audio.blob.text(), 'onetwo');
  assert.equal(restored.recording.state, 'stopped_local');
  assert.equal(restored.recording.providerEpoch, 2);
  assert.equal(restored.cues[0].cue.sourceText, 'hello');
  assert.equal(checkpoint.checkpoint.cueCheckpoint.nextSequence, 2);
});

test('reload recovery resumes audio sequence without overwriting prior chunks', async () => {
  const manifestStore = createInMemoryLocalMeetingManifestStore();
  const chunkStore = fakeChunkStore();
  const first = createLocalMeetingPersistence({
    manifestStore, chunkStore, cryptoImpl: fakeCrypto(), createOperationId: operationIds(), composeAudioArtifact: concatenateTestArtifact
  });
  await first.start({ meetingId: 'meeting-1', recordingId: 'session-1', segmentId: 'segment-1' });
  await first.appendAudioChunk({ data: new Blob(['one']), receivedAt: 10 });
  await first.pause();

  const reloaded = createLocalMeetingPersistence({
    manifestStore, chunkStore, cryptoImpl: fakeCrypto(), createOperationId: operationIds(), composeAudioArtifact: concatenateTestArtifact
  });
  const recovered = await reloaded.start({ meetingId: 'meeting-1', recordingId: 'session-1', segmentId: 'segment-1' });
  assert.equal(recovered.state, 'capturing');
  await reloaded.appendAudioChunk({ data: new Blob(['two']), receivedAt: 20 });
  const audio = await reloaded.finalizeAudio();

  assert.equal(await audio.blob.text(), 'onetwo');
  assert.deepEqual((await manifestStore.list('meeting-1')).map((chunk) => chunk.sequence), [1, 2]);
});

test('recordAudio false never creates a local recording, while true discovers the finalized manifest artifact', async () => {
  const disabledManifest = createInMemoryLocalMeetingManifestStore();
  const disabled = createLocalMeetingPersistence({
    recordAudio: false,
    manifestStore: disabledManifest,
    chunkStore: fakeChunkStore(),
    cryptoImpl: fakeCrypto(),
    createOperationId: operationIds()
  });
  await disabled.start({ meetingId: 'meeting-disabled', recordingId: 'session-disabled', segmentId: 'segment-1' });
  assert.equal(await disabled.appendAudioChunk({ data: new Blob(['ignored']) }), null);
  assert.equal(await disabled.getLocalAudioStatus('meeting-disabled'), 'idle');
  assert.deepEqual(await disabled.listFinalizedAudioArtifacts('meeting-disabled'), []);

  const enabledManifest = createInMemoryLocalMeetingManifestStore();
  const enabled = createLocalMeetingPersistence({
    recordAudio: true,
    manifestStore: enabledManifest,
    chunkStore: fakeChunkStore(),
    cryptoImpl: fakeCrypto(),
    createOperationId: operationIds()
  });
  await enabled.start({ meetingId: 'meeting-enabled', recordingId: 'session-enabled', segmentId: 'segment-1' });
  await enabled.appendAudioChunk({ data: new Blob(['saved']), receivedAt: 10 });
  await enabled.finalizeAudio({ fileName: 'meeting-enabled-input.webm' });
  const artifacts = await enabled.listFinalizedAudioArtifacts('meeting-enabled');
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].recordingId, 'session-enabled');
  assert.equal(await artifacts[0].blob.text(), 'saved');
});

test('stale construction follows hydrated recording enablement without replacing persistence', async () => {
  const manifestStore = createInMemoryLocalMeetingManifestStore();
  const persistence = createLocalMeetingPersistence({ recordAudio: false, manifestStore, chunkStore: fakeChunkStore(), cryptoImpl: fakeCrypto(), createOperationId: operationIds() });
  const disabled = await persistence.start({ meetingId: 'meeting-stale', recordingId: 'session-stale', segmentId: 'segment-1' });
  assert.equal(disabled.state, 'disabled');
  persistence.setRecordingEnabled(true);
  const started = await persistence.start({ meetingId: 'meeting-stale', recordingId: 'session-stale', segmentId: 'segment-1' });
  assert.equal(started.state, 'capturing');
  await persistence.appendAudioChunk({ data: new Blob(['saved']), receivedAt: 10 });
  assert.equal(await persistence.getLocalAudioStatus('meeting-stale'), 'processing');
  const finalized = await persistence.finalizeAudio();
  assert.equal(finalized.status, 'ready');
  assert.equal(await persistence.getLocalAudioStatus('meeting-stale'), 'ready');
  persistence.setRecordingEnabled(false);
  assert.equal((await persistence.listFinalizedAudioArtifacts('meeting-stale')).length, 1);
});
