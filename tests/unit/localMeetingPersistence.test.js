import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalMeetingPersistence } from '../../src/lib/localMeetingPersistence.js';
import { createInMemoryLocalMeetingManifestStore } from '../../src/lib/localMeetingStorage.js';
import { createProviderRecoveryCoordinator } from '../../src/lib/providerRecoveryCoordinator.js';

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

test('production local persistence keeps audio and Writer Cue with cursor-only checkpoint', async () => {
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
  await persistence.commitCueMutation({
    meetingId: 'meeting-1', segmentId: 'segment-1', eventKey: 'cue-event-1', side: 'initial',
    cue: { cueId: 'cue-1', sessionId: 'session-1', segmentId: 'segment-1', sequence: 1,
      startTimeMs: 0, endTimeMs: 100, sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en',
      sourceText: 'hello', translatedText: 'world', status: 'final', finalizedReason: 'final' }
  });
  await persistence.saveTranscriptItem({ meetingId: 'meeting-1', sessionId: 'session-1',
    item: { id: 'source-1', sequence: 1, stream: 'source', text: 'hello',
      status: 'final', segmentId: 'segment-1' } });
  await persistence.updateCheckpoint({
    meetingId: 'meeting-1', segmentId: 'segment-1', idempotencyKey: 'checkpoint-1', durableChunks: [],
    finalCues: [], cueCheckpoint: null
  });
  await persistence.pause();
  await persistence.resume();
  await persistence.providerReconnect();
  await persistence.providerRollover();
  await persistence.appendAudioChunk({ data: new Blob(['two'], { type: 'audio/webm' }), mimeType: 'audio/webm', receivedAt: 20 });

  const audio = await persistence.finalizeAudio({ fileName: 'meeting-1.webm' });
  const restored = await persistence.restore('meeting-1');
  const snapshot = await persistence.contentSnapshot('meeting-1');
  const checkpoint = await persistence.getCheckpoint({ meetingId: 'meeting-1', segmentId: 'segment-1' });
  assert.equal(audio.status, 'sealed');
  assert.equal(audio.blob, null);
  assert.equal(await (await persistence.listFinalizedAudioArtifacts('meeting-1', { kind: 'input' }))[0].blob.text(), 'onetwo');
  assert.equal(restored.recording.state, 'stopped_local');
  assert.equal(restored.recording.providerEpoch, 2);
  assert.equal(restored.cues[0].cue.sourceText, 'hello');
  assert.equal(snapshot.cues[0].cue.sourceText, 'hello');
  assert.equal(snapshot.transcripts[0].segmentId, 'segment-1');
  assert.equal(snapshot.checkpoints[0].segmentId, 'segment-1');
  assert.equal(checkpoint.checkpoint.cueCursor.commitCount, 1);
  assert.deepEqual(checkpoint.checkpoint.finalCues, []);
});

test('B2 checkpoint payload shapes cannot write Cue content through App or Storage', async () => {
  const manifestStore = createInMemoryLocalMeetingManifestStore();
  const persistence = createLocalMeetingPersistence({ manifestStore, chunkStore: fakeChunkStore(), cryptoImpl: fakeCrypto() });
  const scope = { meetingId: 'b2-checkpoint', segmentId: 'segment-1' };
  const cue = { cueId: 'cue-1', sessionId: 'session-1', segmentId: scope.segmentId, sequence: 1,
    startTimeMs: 0, endTimeMs: 100, sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en',
    sourceText: 'committed', translatedText: 'world', status: 'final', finalizedReason: 'final' };
  await persistence.commitCueMutation({ ...scope, eventKey: 'event-1', side: 'initial', cue });
  const committed = await persistence.listCues(scope.meetingId);
  for (const [index, extra] of [{ finalCues: [] }, { finalCues: [{ ...cue, sourceText: 'stale' }] }, {}].entries()) {
    await persistence.updateCheckpoint({ ...scope, idempotencyKey: `checkpoint-${index}`, durableChunks: [], ...extra });
    assert.deepEqual(await persistence.listCues(scope.meetingId), committed);
    assert.deepEqual((await persistence.getCheckpoint(scope)).checkpoint.finalCues, []);
  }
  await assert.rejects(manifestStore.saveCheckpointCursor({ ...scope, checkpoint: {
    idempotencyKey: 'forbidden', finalCues: [cue]
  } }), (error) => error.code === 'local_checkpoint_cue_content_forbidden');
  assert.deepEqual(await persistence.listCues(scope.meetingId), committed);
});

test('explicit local lifecycle operation IDs replay without advancing the segment twice', async () => {
  const manifestStore = createInMemoryLocalMeetingManifestStore();
  const options = { manifestStore, chunkStore: fakeChunkStore(), cryptoImpl: fakeCrypto(), createOperationId: operationIds() };
  const first = createLocalMeetingPersistence(options);
  await first.start({ meetingId: 'meeting-idempotent', recordingId: 'recording-idempotent', segmentId: 'segment-1', operationId: 'start-1' });
  const paused = await first.pause({ operationId: 'pause-1' });
  assert.deepEqual(await first.pause({ operationId: 'pause-1' }), paused);
  const resumed = await first.resume({ operationId: 'continue-1' });
  assert.deepEqual(await first.resume({ operationId: 'continue-1' }), resumed);
  assert.equal(resumed.segmentId, 'segment:recording-idempotent:2');

  const reloaded = createLocalMeetingPersistence(options);
  await reloaded.start({ meetingId: 'meeting-idempotent', recordingId: 'recording-idempotent', segmentId: 'segment-1' });
  assert.deepEqual(await reloaded.resume({ operationId: 'continue-1' }), resumed);
  assert.equal((await reloaded.restore('meeting-idempotent')).recording.segmentId, 'segment:recording-idempotent:2');
});

test('End keeps a retryable local completion intent and a fixed 30 minute deadline after reload', async () => {
  const retentions = new Map();
  const manifestStore = {
    ...createInMemoryLocalMeetingManifestStore(),
    async getRetention(meetingId) { return retentions.get(meetingId) || null; },
    async listRetentions() { return [...retentions.values()]; },
    async saveRetention(input) {
      const record = { ...retentions.get(input.meetingId), ...input };
      retentions.set(input.meetingId, record);
      return record;
    }
  };
  const options = { manifestStore, chunkStore: fakeChunkStore(), cryptoImpl: fakeCrypto(), now: () => 1000 };
  const host = createLocalMeetingPersistence(options);
  await host.startLifecycle({ meetingId: 'meeting-end', recordingId: 'recording-end',
    segmentId: 'segment-1', operationId: 'start-1' });
  await host.endLifecycle({ operationId: 'stop-1' });
  await host.savePendingCompletion({ meetingId: 'meeting-end', operationId: 'end-1' });

  const reloaded = createLocalMeetingPersistence(options);
  assert.deepEqual(await reloaded.getPendingCompletion('meeting-end'), {
    operationId: 'end-1', sealedAt: new Date(1000).toISOString()
  });
  assert.equal((await manifestStore.getRetention('meeting-end')).expiresAt,
    new Date(1000 + 30 * 60 * 1000).toISOString());
  await reloaded.clearPendingCompletion({ meetingId: 'meeting-end', meeting: { purgeAt: new Date(1000 + 30 * 60 * 1000).toISOString() } });
  assert.equal(await reloaded.getPendingCompletion('meeting-end'), null);
  assert.equal((await reloaded.restore('meeting-end')).recording.state, 'stopped_local');
});

test('committed local rollover survives Provider startup failure and Reload without a second Segment', async () => {
  const manifestStore = createInMemoryLocalMeetingManifestStore();
  const options = { manifestStore, chunkStore: fakeChunkStore(), cryptoImpl: fakeCrypto() };
  const host = createLocalMeetingPersistence(options);
  await host.startLifecycle({ meetingId: 'meeting-recovery', recordingId: 'recording-recovery',
    segmentId: 'segment-1', operationId: 'start-1' });
  const committed = await host.rolloverLocalSegment({ operationId: 'rollover:recording-recovery:segment-1',
    nextSegmentId: 'segment:recording-recovery:2' });
  // Simulate reload before the successor Provider session becomes ready.
  const reloaded = createLocalMeetingPersistence(options);
  assert.equal((await reloaded.restore('meeting-recovery')).recording.segmentId, committed.segmentId);
  assert.deepEqual(await reloaded.rolloverLocalSegment({ operationId: 'rollover:recording-recovery:segment-1',
    nextSegmentId: committed.segmentId }), committed);
  assert.equal((await manifestStore.getRecording('meeting-recovery')).segmentNumber, 2);
});

test('Host lifecycle remains durable when input audio recording is disabled', async () => {
  const manifestStore = createInMemoryLocalMeetingManifestStore();
  const options = { manifestStore, chunkStore: fakeChunkStore(), cryptoImpl: fakeCrypto(), recordAudio: false };
  const host = createLocalMeetingPersistence(options);
  const started = await host.startLifecycle({ meetingId: 'meeting-local', recordingId: 'session-local', segmentId: 'segment-local', operationId: 'start-local' });
  assert.equal(started.state, 'capturing');
  assert.equal((await host.start({ meetingId: 'meeting-local' })).state, 'disabled');
  await host.pauseLifecycle({ operationId: 'pause-local' });
  const continued = await host.continueLifecycle({ operationId: 'continue-local' });
  assert.equal(continued.state, 'capturing');
  assert.equal(continued.segmentId, 'segment:session-local:2');
  assert.deepEqual(await host.continueLifecycle({ operationId: 'continue-local' }), continued);
  await host.endLifecycle({ operationId: 'end-local' });
  const reloaded = createLocalMeetingPersistence(options);
  assert.equal((await reloaded.restore('meeting-local')).recording.state, 'stopped_local');
});

test('Stop seals without composing; export failure preserves sealed chunks for retry', async () => {
  const manifestStore = createInMemoryLocalMeetingManifestStore();
  let composeCount = 0;
  let failExport = true;
  const persistence = createLocalMeetingPersistence({
    manifestStore, chunkStore: fakeChunkStore(), cryptoImpl: fakeCrypto(),
    createOperationId: operationIds(),
    composeAudioArtifact: async (input) => {
      composeCount += 1;
      if (failExport) throw new Error('decode failed');
      return concatenateTestArtifact(input);
    }
  });
  await persistence.start({ meetingId: 'meeting-seal', recordingId: 'recording-seal', segmentId: 'segment-a' });
  await persistence.appendAudioChunk({ data: new Blob(['audio']), receivedAt: 10 });
  assert.equal((await persistence.finalizeAudio()).status, 'sealed');
  assert.equal(composeCount, 0);
  assert.deepEqual((await persistence.listFinalizedAudioArtifactMetadata('meeting-seal')).map((item) => item.kind), ['input']);
  assert.equal(composeCount, 0);
  await assert.rejects(persistence.listFinalizedAudioArtifacts('meeting-seal', { kind: 'input' }), /decode failed/u);
  assert.equal((await persistence.restore('meeting-seal')).recording.state, 'stopped_local');
  assert.equal((await manifestStore.list('meeting-seal')).length, 1);
  failExport = false;
  const [artifact] = await persistence.listFinalizedAudioArtifacts('meeting-seal', { kind: 'input' });
  assert.equal(await artifact.blob.text(), 'audio');
  assert.equal(composeCount, 2);
});

test('Stop refuses a failed recording manifest commit', async () => {
  const base = createInMemoryLocalMeetingManifestStore();
  const manifestStore = {
    ...base,
    commitRecordingOperation(input) {
      if (input.recording.state === 'stopped_local') throw new Error('IndexedDB commit failed');
      return base.commitRecordingOperation(input);
    }
  };
  const persistence = createLocalMeetingPersistence({
    manifestStore, chunkStore: fakeChunkStore(), cryptoImpl: fakeCrypto(),
    createOperationId: operationIds(), composeAudioArtifact: concatenateTestArtifact
  });
  await persistence.start({ meetingId: 'meeting-fail', recordingId: 'recording-fail', segmentId: 'segment-1' });
  await persistence.appendAudioChunk({ data: new Blob(['audio']), receivedAt: 10 });
  await assert.rejects(persistence.finalizeAudio(), /IndexedDB commit failed/u);
  assert.notEqual((await base.getRecording('meeting-fail')).state, 'stopped_local');
});

test('three sealed Segment manifests reload and export in recording order', async () => {
  const manifestStore = createInMemoryLocalMeetingManifestStore();
  const chunkStore = fakeChunkStore();
  const createPersistence = () => createLocalMeetingPersistence({
    manifestStore, chunkStore, cryptoImpl: fakeCrypto(),
    createOperationId: operationIds(), composeAudioArtifact: concatenateTestArtifact
  });
  const host = createPersistence();
  await host.start({ meetingId: 'meeting-three', recordingId: 'recording-three', segmentId: 'segment-1' });
  for (let segment = 1; segment <= 3; segment += 1) {
    await host.appendAudioChunk({ data: new Blob([String(segment)]), receivedAt: segment });
    if (segment < 3) await host.rolloverLocalSegment({ nextSegmentId: `segment-${segment + 1}` });
  }
  assert.equal((await host.finalizeAudio()).status, 'sealed');
  const reloaded = createPersistence();
  const [metadata] = await reloaded.listFinalizedAudioArtifactMetadata('meeting-three');
  const [artifact] = await reloaded.listFinalizedAudioArtifacts('meeting-three', { kind: 'input' });
  assert.equal(metadata.recordingId, 'recording-three');
  assert.equal(artifact.captureSegmentCount, 3);
  assert.deepEqual(artifact.segments.map((segment) => segment.segmentId), ['segment-1', 'segment-2', 'segment-3']);
  assert.equal(await artifact.blob.text(), '123');
});

test('translated PCM survives reload and corrupt chunks fail on-demand export', async () => {
  const manifestStore = createInMemoryLocalMeetingManifestStore();
  const chunkStore = fakeChunkStore();
  const makePersistence = () => createLocalMeetingPersistence({
    manifestStore, chunkStore,
    cryptoImpl: { subtle: { async digest(_algorithm, bytes) { return new Uint8Array(bytes).buffer; } } },
    createOperationId: operationIds(),
    composeAudioArtifact: concatenateTestArtifact
  });
  const first = makePersistence();
  await first.start({ meetingId: 'meeting-1', recordingId: 'session-1', segmentId: 'segment-1' });
  await first.appendTranslatedAudioChunk({ meetingId: 'meeting-1', sessionId: 'session-1', bytes: new Uint8Array([1, 0, 2, 0]) });
  assert.equal((await first.finalizeTranslatedAudio()).status, 'sealed');
  const reloaded = makePersistence();
  const artifacts = await reloaded.listFinalizedAudioArtifacts('meeting-1');
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].kind, 'translation');
  assert.equal(artifacts[0].mimeType, 'audio/wav');
  assert.equal(artifacts[0].blob.size, 48);
  const [chunk] = await manifestStore.listTranslatedAudioChunks('meeting-1');
  chunkStore.files.set(chunk.path, new Uint8Array([9, 0, 2, 0]));
  assert.equal((await first.finalizeTranslatedAudio()).status, 'sealed');
  await assert.rejects(first.listFinalizedAudioArtifacts('meeting-1', { kind: 'translation' }), /corrupt/u);
});

test('Segment seal waits for local audio and refuses a failed chunk', async () => {
  const manifestStore = createInMemoryLocalMeetingManifestStore();
  const chunkStore = fakeChunkStore();
  const originalWrite = chunkStore.write;
  let releaseWrite;
  const gate = new Promise((resolve) => { releaseWrite = resolve; });
  chunkStore.write = async (path, bytes) => { await gate; return originalWrite(path, bytes); };
  const persistence = createLocalMeetingPersistence({
    manifestStore, chunkStore, cryptoImpl: fakeCrypto(), createOperationId: operationIds(),
    composeAudioArtifact: concatenateTestArtifact
  });
  await persistence.start({ meetingId: 'meeting-1', recordingId: 'session-1', segmentId: 'segment-1' });
  const append = persistence.appendAudioChunk({ data: new Blob(['audio']), receivedAt: 10 });
  let sealed = false;
  const seal = persistence.sealSegmentWrites('meeting-1').then(() => { sealed = true; });
  await Promise.resolve();
  assert.equal(sealed, false);
  releaseWrite();
  await append;
  await seal;
  assert.equal(sealed, true);
  chunkStore.write = async () => { throw new Error('OPFS failed'); };
  await assert.rejects(persistence.appendAudioChunk({ data: new Blob(['missing']), receivedAt: 11 }), /OPFS failed/u);
  await assert.rejects(persistence.sealSegmentWrites('meeting-1'), /OPFS failed/u);
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

  assert.equal(audio.status, 'sealed');
  assert.equal(await (await reloaded.listFinalizedAudioArtifacts('meeting-1', { kind: 'input' }))[0].blob.text(), 'onetwo');
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
  assert.equal(finalized.status, 'sealed');
  assert.equal(await persistence.getLocalAudioStatus('meeting-stale'), 'sealed');
  persistence.setRecordingEnabled(false);
  assert.equal((await persistence.listFinalizedAudioArtifacts('meeting-stale')).length, 1);
});

test('a new meeting gets a distinct chunk identity and preserves the interrupted meeting audio', async () => {
  const manifestStore = createInMemoryLocalMeetingManifestStore();
  const persistence = createLocalMeetingPersistence({
    manifestStore,
    chunkStore: fakeChunkStore(),
    cryptoImpl: fakeCrypto(),
    createOperationId: operationIds(),
    composeAudioArtifact: concatenateTestArtifact
  });

  await persistence.start({ meetingId: 'meeting-1', recordingId: 'recording-1', segmentId: 'segment-1' });
  await persistence.appendAudioChunk({ data: new Blob(['old']), receivedAt: 10 });
  await persistence.pause();

  await persistence.start({ meetingId: 'meeting-2', recordingId: 'recording-2', segmentId: 'segment-2' });
  await persistence.appendAudioChunk({ data: new Blob(['new']), receivedAt: 20 });
  const finalized = await persistence.finalizeAudio();

  assert.equal(finalized.status, 'sealed');
  assert.equal(await (await persistence.listFinalizedAudioArtifacts('meeting-2', { kind: 'input' }))[0].blob.text(), 'new');
  assert.deepEqual((await manifestStore.list('meeting-1')).map((chunk) => chunk.chunkId), ['recording-1:audio-00000001']);
  assert.deepEqual((await manifestStore.list('meeting-2')).map((chunk) => chunk.chunkId), ['recording-2:audio-00000001']);
  assert.equal((await manifestStore.list('meeting-1'))[0].state, 'sealed');
});

test('starting the next meeting waits for the previous OPFS chunk write barrier', async () => {
  const manifestStore = createInMemoryLocalMeetingManifestStore();
  let releaseWrite;
  const writeBarrier = new Promise((resolve) => { releaseWrite = resolve; });
  const chunkStore = fakeChunkStore();
  const originalWrite = chunkStore.write;
  chunkStore.write = async (...args) => {
    await writeBarrier;
    return originalWrite(...args);
  };
  const persistence = createLocalMeetingPersistence({
    manifestStore,
    chunkStore,
    cryptoImpl: fakeCrypto(),
    createOperationId: operationIds(),
    composeAudioArtifact: concatenateTestArtifact
  });

  await persistence.start({ meetingId: 'meeting-1', recordingId: 'recording-1', segmentId: 'segment-1' });
  const append = persistence.appendAudioChunk({ data: new Blob(['old']), receivedAt: 10 });
  let nextStarted = false;
  const nextStart = persistence.start({ meetingId: 'meeting-2', recordingId: 'recording-2', segmentId: 'segment-2' })
    .then((result) => { nextStarted = true; return result; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(nextStarted, false);

  releaseWrite();
  await append;
  assert.equal((await nextStart).meetingId, 'meeting-2');
  assert.equal((await manifestStore.list('meeting-1'))[0].state, 'sealed');
});

test('rapid pause and continue keeps one recording identity and monotonic chunk sequence', async () => {
  const manifestStore = createInMemoryLocalMeetingManifestStore();
  const persistence = createLocalMeetingPersistence({
    manifestStore,
    chunkStore: fakeChunkStore(),
    cryptoImpl: fakeCrypto(),
    createOperationId: operationIds(),
    composeAudioArtifact: concatenateTestArtifact
  });
  const started = await persistence.start({ meetingId: 'meeting-1', recordingId: 'recording-1', segmentId: 'segment-1' });

  for (let sequence = 1; sequence <= 3; sequence += 1) {
    await persistence.appendAudioChunk({ data: new Blob([String(sequence)]), receivedAt: sequence });
    await persistence.pause();
    await persistence.resume();
  }
  const finalized = await persistence.finalizeAudio();
  const chunks = await manifestStore.list('meeting-1');

  assert.equal((await persistence.restore('meeting-1')).recording.recordingId, started.recordingId);
  assert.deepEqual(chunks.map((chunk) => chunk.sequence), [1, 2, 3]);
  assert.equal(finalized.status, 'sealed');
  assert.equal(await (await persistence.listFinalizedAudioArtifacts('meeting-1', { kind: 'input' }))[0].blob.text(), '123');
});

test('rollover barrier assigns pending chunks to the old Segment and later chunks to the committed Segment', async () => {
  const manifestStore = createInMemoryLocalMeetingManifestStore();
  const chunkStore = fakeChunkStore();
  const originalWrite = chunkStore.write;
  let releaseFirstWrite;
  let writeCount = 0;
  const firstWriteBarrier = new Promise((resolve) => { releaseFirstWrite = resolve; });
  chunkStore.write = async (...args) => {
    writeCount += 1;
    if (writeCount === 1) await firstWriteBarrier;
    return originalWrite(...args);
  };
  const persistence = createLocalMeetingPersistence({
    manifestStore, chunkStore, cryptoImpl: fakeCrypto(), createOperationId: operationIds(), composeAudioArtifact: concatenateTestArtifact
  });
  const started = await persistence.start({ meetingId: 'meeting-1', recordingId: 'recording-1', segmentId: 'segment-1' });

  const pending = persistence.appendAudioChunk({ data: new Blob(['old']), receivedAt: 10 });
  const rollover = persistence.rolloverLocalSegment({ operationId: 'rollover-1', nextSegmentId: 'segment-2' });
  const afterRollover = persistence.appendAudioChunk({ data: new Blob(['new']), receivedAt: 20 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await manifestStore.list('meeting-1'))[0].segmentId, 'segment-1');

  releaseFirstWrite();
  const [, rolled] = await Promise.all([pending, rollover, afterRollover]);
  const chunks = await manifestStore.list('meeting-1');
  assert.deepEqual(chunks.map(({ sequence, segmentId }) => ({ sequence, segmentId })), [
    { sequence: 1, segmentId: 'segment-1' },
    { sequence: 2, segmentId: 'segment-2' }
  ]);
  assert.equal(rolled.recordingId, started.recordingId);
  assert.equal(rolled.captureEpoch, started.captureEpoch);
  assert.equal(rolled.providerEpoch, started.providerEpoch + 1);
});

test('disabled local rollover blocks later chunks from the old Segment', async () => {
  const manifestStore = createInMemoryLocalMeetingManifestStore();
  const persistence = createLocalMeetingPersistence({
    manifestStore,
    chunkStore: fakeChunkStore(),
    cryptoImpl: fakeCrypto(),
    createOperationId: operationIds(),
    composeAudioArtifact: concatenateTestArtifact
  });
  await persistence.start({ meetingId: 'meeting-1', recordingId: 'recording-1', segmentId: 'segment-1' });
  await persistence.appendAudioChunk({ data: new Blob(['old']), receivedAt: 10 });
  persistence.setRecordingEnabled(false);
  assert.equal((await persistence.rolloverLocalSegment({ operationId: 'rollover-1', nextSegmentId: 'segment-2' })).state, 'disabled');
  persistence.setRecordingEnabled(true);
  await assert.rejects(persistence.appendAudioChunk({ data: new Blob(['new']), receivedAt: 20 }), /rollover is disabled/);
  await assert.rejects(persistence.sealSegmentWrites('meeting-1'), /rollover is disabled/);
  assert.deepEqual((await manifestStore.list('meeting-1')).map((chunk) => chunk.segmentId), ['segment-1']);
});

test('local persistence traces chunk receive and the serialized Segment scope switch', async () => {
  const events = [];
  const persistence = createLocalMeetingPersistence({
    manifestStore: createInMemoryLocalMeetingManifestStore(),
    chunkStore: fakeChunkStore(),
    cryptoImpl: fakeCrypto(),
    createOperationId: operationIds(),
    composeAudioArtifact: concatenateTestArtifact,
    trace: (event) => events.push(event)
  });
  await persistence.start({ meetingId: 'meeting-1', recordingId: 'recording-1', segmentId: 'segment-1' });
  await persistence.appendAudioChunk({ data: new Blob(['old']), receivedAt: 10 });
  await persistence.rolloverLocalSegment({ operationId: 'rollover-1', nextSegmentId: 'segment-2' });
  await persistence.appendAudioChunk({ data: new Blob(['new']), receivedAt: 20 });

  const received = events.filter((event) => event.stage === 'LOCAL_CHUNK_RECEIVED');
  const switched = events.find((event) => event.stage === 'LOCAL_SEGMENT_SCOPE_SWITCHED');
  assert.deepEqual(received.map((event) => [event.chunkId, event.segmentId]), [
    ['recording-1:audio-00000001', 'segment-1'],
    ['recording-1:audio-00000002', 'segment-2']
  ]);
  assert.equal(switched.operationId, 'rollover-1');
  assert.equal(switched.oldSegmentId, 'segment-1');
  assert.equal(switched.newSegmentId, 'segment-2');
  assert.equal(switched.captureEpoch, 1);
  assert.equal(switched.providerEpoch, 1);
});

test('exhausted Provider recovery does not block OPFS chunks before or after rollover', async () => {
  const manifestStore = createInMemoryLocalMeetingManifestStore();
  const persistence = createLocalMeetingPersistence({
    manifestStore,
    chunkStore: fakeChunkStore(),
    cryptoImpl: fakeCrypto(),
    createOperationId: operationIds(),
    composeAudioArtifact: concatenateTestArtifact,
    trace: () => {}
  });
  const recovery = createProviderRecoveryCoordinator({
    retryDelaysMs: [0, 0, 0],
    wait: async () => {},
    execute: async () => false
  });
  await persistence.start({ meetingId: 'meeting-1', recordingId: 'recording-1', segmentId: 'segment-1' });
  await persistence.appendAudioChunk({ data: new Blob(['before']), receivedAt: 10 });
  await persistence.rolloverLocalSegment({ operationId: 'rollover-1', nextSegmentId: 'segment-2' });

  const [result] = await Promise.all([
    recovery.run({ operationId: 'provider-recovery-1', segmentId: 'segment-2' }),
    persistence.appendAudioChunk({ data: new Blob(['during']), receivedAt: 20 })
  ]);
  const after = await persistence.appendAudioChunk({ data: new Blob(['after']), receivedAt: 30 });
  const chunks = await manifestStore.list('meeting-1');

  assert.equal(result.status, 'exhausted');
  assert.equal(after.state, 'sealed');
  assert.deepEqual(chunks.map((chunk) => [chunk.sequence, chunk.segmentId, chunk.state]), [
    [1, 'segment-1', 'sealed'],
    [2, 'segment-2', 'sealed'],
    [3, 'segment-2', 'sealed']
  ]);
});

test('failed chunk exposes one immutable descriptor for an exact retry', async () => {
  const manifestStore = createInMemoryLocalMeetingManifestStore();
  const chunkStore = fakeChunkStore();
  const originalWrite = chunkStore.write;
  let failFirstWrite = true;
  chunkStore.write = async (...args) => {
    if (failFirstWrite) {
      failFirstWrite = false;
      throw new Error('transient OPFS failure');
    }
    return originalWrite(...args);
  };
  const persistence = createLocalMeetingPersistence({
    manifestStore, chunkStore, cryptoImpl: fakeCrypto(), createOperationId: operationIds(), composeAudioArtifact: concatenateTestArtifact
  });
  await persistence.start({ meetingId: 'meeting-1', recordingId: 'recording-1', segmentId: 'segment-1' });
  const data = new Blob(['retry-me']);

  let descriptor;
  const originalInfo = console.info;
  let safeFailure;
  console.info = (label, detail) => {
    if (label === 'ISSUE41_LOCAL_APPEND_FAILURE') safeFailure = detail;
    else originalInfo(label, detail);
  };
  try {
    await assert.rejects(
      persistence.appendAudioChunk({ data, receivedAt: 10 }),
      (error) => {
        descriptor = error.localChunkDescriptor;
        return error.message === 'transient OPFS failure' && Object.isFrozen(descriptor);
      }
    );
  } finally {
    console.info = originalInfo;
  }
  assert.equal(safeFailure.operation, 'ORIGINAL_AUDIO');
  assert.equal(safeFailure.recordingId, 'recording-1');
  assert.equal(safeFailure.segmentId, 'segment-1');
  assert.doesNotMatch(JSON.stringify(safeFailure), /transient OPFS failure|retry-me/u);
  const retried = await persistence.appendAudioChunk({ data, descriptor });
  const next = await persistence.appendAudioChunk({ data: new Blob(['next']), receivedAt: 20 });

  assert.equal(retried.sequence, 1);
  assert.equal(next.sequence, 2);
  assert.equal(retried.chunkId, 'recording-1:audio-00000001');
});

test('identity conflict consumes only its allocated sequence and later chunks continue saving', async () => {
  const manifestStore = createInMemoryLocalMeetingManifestStore();
  await manifestStore.reserve({
    meetingId: 'meeting-old', recordingId: 'different-recording', segmentId: 'segment-old',
    chunkId: 'recording-1:audio-00000001', sequence: 1, startedAt: 1
  });
  const persistence = createLocalMeetingPersistence({
    manifestStore, chunkStore: fakeChunkStore(), cryptoImpl: fakeCrypto(), createOperationId: operationIds(), composeAudioArtifact: concatenateTestArtifact
  });
  await persistence.start({ meetingId: 'meeting-1', recordingId: 'recording-1', segmentId: 'segment-1' });

  await assert.rejects(
    persistence.appendAudioChunk({ data: new Blob(['conflict']), receivedAt: 10 }),
    (error) => error.code === 'local_chunk_identity_conflict'
  );
  const saved = await persistence.appendAudioChunk({ data: new Blob(['continues']), receivedAt: 20 });
  assert.equal(saved.sequence, 2);
  assert.equal(saved.state, 'sealed');
});

test('legacy unscoped chunk IDs remain readable without rewriting IndexedDB or OPFS', async () => {
  const manifestStore = createInMemoryLocalMeetingManifestStore();
  const chunkStore = fakeChunkStore();
  const legacy = await manifestStore.reserve({
    meetingId: 'meeting-legacy', recordingId: 'recording-legacy', segmentId: 'segment-1',
    chunkId: 'audio-00000001', sequence: 1, startedAt: 10, endedAt: 10,
    byteSize: 6, checksum: 'sha256:legacy', mimeType: 'audio/webm'
  });
  await chunkStore.write(legacy.path, new TextEncoder().encode('legacy'));
  await manifestStore.seal(legacy.chunkId, { byteSize: 6, checksum: 'sha256:legacy', endedAt: 10 });
  await manifestStore.saveRecording({
    meetingId: 'meeting-legacy', recordingId: 'recording-legacy', segmentId: 'segment-1', segmentNumber: 1,
    captureEpoch: 1, providerEpoch: 0, finalSequence: 1, state: 'stopped_local', terminal: true, finalized: true
  });
  const persistence = createLocalMeetingPersistence({
    manifestStore, chunkStore, cryptoImpl: fakeCrypto(), createOperationId: operationIds(), composeAudioArtifact: concatenateTestArtifact
  });

  const [artifact] = await persistence.listFinalizedAudioArtifacts('meeting-legacy');
  assert.equal(await artifact.blob.text(), 'legacy');
  assert.equal(artifact.segments[0].chunkId, 'audio-00000001');
});

for (const continuedAfterFirstReload of [false, true]) {
  test(`paused local End after reload seals once and survives metadata retry (continued: ${continuedAfterFirstReload})`, async () => {
    const retentions = new Map();
    const manifestStore = {
      ...createInMemoryLocalMeetingManifestStore(),
      async getRetention(meetingId) { return retentions.get(meetingId) || null; },
      async listRetentions() { return [...retentions.values()]; },
      async saveRetention(input) {
        const record = { ...retentions.get(input.meetingId), ...input };
        retentions.set(input.meetingId, record);
        return record;
      }
    };
    const chunkStore = fakeChunkStore();
    const options = {
      manifestStore, chunkStore, cryptoImpl: fakeCrypto(),
      createOperationId: operationIds(), composeAudioArtifact: concatenateTestArtifact
    };
    const meetingId = 'meeting-reload-end';
    const host = createLocalMeetingPersistence(options);
    await host.start({ meetingId, recordingId: 'recording-1', segmentId: 'segment-1' });
    await host.appendAudioChunk({ data: new Blob(['first']), mimeType: 'audio/webm', receivedAt: 10 });
    await host.pause({ operationId: 'pause-1' });

    if (continuedAfterFirstReload) {
      const continued = createLocalMeetingPersistence(options);
      await continued.start({ meetingId, recordingId: 'recording-1', segmentId: 'segment-1' });
      await continued.resume({ operationId: 'continue-1' });
      await continued.appendAudioChunk({ data: new Blob(['second']), mimeType: 'audio/webm', receivedAt: 20 });
      await continued.pause({ operationId: 'pause-2' });
    }

    const reloaded = createLocalMeetingPersistence(options);
    await assert.rejects(reloaded.finalizeAudio(), /Local audio chunks are not completely sealed/u);
    assert.equal((await reloaded.getLocalRecording(meetingId)).state, 'paused');
    await reloaded.restore(meetingId);
    assert.equal((await reloaded.finalizeAudio()).status, 'sealed');
    await reloaded.endLifecycle({ operationId: 'end-1' });
    await reloaded.savePendingCompletion({ meetingId, operationId: 'end-1' });
    assert.equal((await reloaded.getLocalRecording(meetingId)).state, 'stopped_local');
    assert.equal((await reloaded.getPendingCompletion(meetingId)).operationId, 'end-1');

    const retry = createLocalMeetingPersistence(options);
    await retry.restore(meetingId);
    assert.equal((await retry.finalizeAudio()).status, 'sealed');
    await retry.endLifecycle({ operationId: 'end-1' });
    await retry.savePendingCompletion({ meetingId, operationId: 'end-1' });
    const segments = await retry.listLocalSegments(meetingId);
    assert.equal(segments.length, continuedAfterFirstReload ? 2 : 1);
    const [artifact] = await retry.listFinalizedAudioArtifacts(meetingId, { kind: 'input' });
    assert.equal(await artifact.blob.text(), continuedAfterFirstReload ? 'firstsecond' : 'first');
    await retry.clearPendingCompletion({ meetingId, meeting: { purgeAt: new Date(Date.now() + 30 * 60 * 1000).toISOString() } });
    assert.equal(await retry.getPendingCompletion(meetingId), null);
  });
}
