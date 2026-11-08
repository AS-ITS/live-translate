import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chromium } from '@playwright/test';
import { rolldown } from 'rolldown';
import {
  buildLocalChunkPath,
  createIndexedDbLocalMeetingManifestStore,
  createInMemoryLocalMeetingManifestStore,
  markLocalChunk,
  reconcileLocalMeetingChunks,
  reserveLocalChunk,
  sealLocalChunk
} from '../../src/lib/localMeetingStorage.js';

let storageBundle;
function bundledLocalStorageSource() {
  storageBundle ||= (async () => {
    const bundle = await rolldown({ input: fileURLToPath(new URL('../../src/lib/localMeetingStorage.js', import.meta.url)) });
    try {
      const { output } = await bundle.generate({ format: 'es' });
      return output[0].code;
    } finally {
      await bundle.close();
    }
  })();
  return storageBundle;
}

let lifecycleRecoveryBundle;
function bundledLifecycleRecoverySource() {
  lifecycleRecoveryBundle ||= (async () => {
    const bundle = await rolldown({ input: fileURLToPath(new URL('../../src/lib/lifecycleRecoveryController.js', import.meta.url)) });
    try {
      const { output } = await bundle.generate({ format: 'es' });
      return output[0].code;
    } finally {
      await bundle.close();
    }
  })();
  return lifecycleRecoveryBundle;
}

let localPersistenceBundle;
function bundledLocalPersistenceSource() {
  localPersistenceBundle ||= (async () => {
    const bundle = await rolldown({ input: fileURLToPath(new URL('../../src/lib/localMeetingPersistence.js', import.meta.url)) });
    try {
      const { output } = await bundle.generate({ format: 'es' });
      return output[0].code;
    } finally {
      await bundle.close();
    }
  })();
  return localPersistenceBundle;
}

test('recording and operation persistence project secrets from writes and reads', async () => {
  const store = createInMemoryLocalMeetingManifestStore();
  const recording = {
    meetingId: 'meeting-1',
    recordingId: 'recording-1',
    segmentId: 'segment-2',
    segmentNumber: 2,
    captureEpoch: 3,
    providerEpoch: 4,
    state: 'capturing',
    finalSequence: null,
    terminal: false,
    finalized: false,
    geminiApiKey: 'must-not-persist',
    ephemeralToken: 'must-not-persist'
  };
  const result = { ...recording, stopError: null, apiKey: 'must-not-persist' };

  await store.commitRecordingOperation({
    recording,
    operation: {
      meetingId: 'meeting-1',
      operationId: 'recover-1',
      type: 'recover',
      result,
      accessToken: 'must-not-persist'
    }
  });

  const persistedRecording = await store.getRecording('meeting-1');
  const persistedOperation = await store.getOperation('meeting-1', 'recover-1');
  assert.equal(persistedRecording.geminiApiKey, undefined);
  assert.equal(persistedRecording.ephemeralToken, undefined);
  assert.equal(persistedOperation.accessToken, undefined);
  assert.equal(persistedOperation.result.apiKey, undefined);
  assert.equal(persistedOperation.result.segmentId, 'segment-2');
});

test('local Transcript updates retain sequence and original Segment through reload snapshots', async () => {
  const store = createInMemoryLocalMeetingManifestStore();
  const base = { meetingId: 'meeting-1', sessionId: 'session-1' };
  const partial = { id: 'source-1', stream: 'source', sequence: 1,
    text: 'hello', status: 'partial', segmentId: 'segment-1' };
  await store.saveTranscriptItem({ ...base, item: partial });
  await store.saveTranscriptItem({ ...base, item: { ...partial, text: 'hello world', status: 'final' } });
  await store.saveTranscriptItem({ ...base, item: { id: 'translation-2', stream: 'translation',
    sequence: 2, text: '你好世界', status: 'final', segmentId: 'segment-1' } });
  assert.deepEqual((await store.listTranscriptItems('meeting-1')).map((row) =>
    [row.sequence, row.segmentId, row.revision, row.item.text]),
  [[1, 'segment-1', 2, 'hello world'], [2, 'segment-1', 1, '你好世界']]);
  await assert.rejects(store.saveTranscriptItem({ ...base, item: { ...partial,
    text: 'late old cue', segmentId: 'segment-2' } }), { code: 'local_transcript_identity_conflict' });
});

test('meeting deletion removes B2 Cue content and rejects late writes', async () => {
  const store = createInMemoryLocalMeetingManifestStore();
  const input = { meetingId: 'meeting-1', segmentId: 'segment-1', eventKey: 'cue-1',
    side: 'initial', cue: { cueId: 'cue-1', sessionId: 'session-1', segmentId: 'segment-1',
      sequence: 1, startTimeMs: 0, endTimeMs: 100, status: 'final',
      sourceText: 'hello', translatedText: 'world', sourceLanguageCode: 'en',
      targetLanguageCode: 'fr', sourceStatus: 'finalized', translationStatus: 'finalized' } };
  assert.equal((await store.commitCueMutation(input)).status, 'committed');
  await store.clearMeetingContent('meeting-1');
  assert.deepEqual(await store.listCues('meeting-1'), []);
  await assert.rejects(store.commitCueMutation({ ...input, eventKey: 'late' }),
    { code: 'meeting_content_expired' });
  await assert.rejects(store.saveCheckpointCursor({ meetingId: 'meeting-1', segmentId: 'segment-1',
    checkpoint: { idempotencyKey: 'late', durableChunks: [], finalCues: [] } }),
  { code: 'meeting_content_expired' });
});

test('chunk paths are deterministic and keep meeting identity in the path', () => {
  assert.equal(
    buildLocalChunkPath({ meetingId: 'meeting-1', segmentId: 'segment-2', sequence: 7, chunkId: 'chunk-a' }),
    'meetings/meeting-1/segments/segment-2/chunks/00000007-chunk-a.webm'
  );
});

test('reserve then seal produces an immutable local chunk identity', () => {
  const reserved = reserveLocalChunk({
    meetingId: 'meeting-1',
    segmentId: 'segment-1',
    chunkId: 'chunk-1',
    sequence: 1,
    startedAt: 1000
  });
  assert.equal(reserved.state, 'writing');
  const sealed = sealLocalChunk(reserved, { byteSize: 12, checksum: 'sha256:abc', endedAt: 2000 });
  assert.equal(sealed.state, 'sealed');
  assert.equal(sealed.sequence, 1);
  assert.equal(sealed.path, reserved.path);
  assert.throws(() => sealLocalChunk(sealed, { byteSize: 1, checksum: 'sha256:bad', endedAt: 3000 }), (error) => error.code === 'local_chunk_seal_conflict');
});

test('reconciliation seals a closed writing file and marks missing or corrupt files', () => {
  const writing = reserveLocalChunk({ meetingId: 'meeting-1', segmentId: 'segment-1', chunkId: 'chunk-1', sequence: 1, startedAt: 0, byteSize: 5, checksum: 'sha256:one' });
  const sealed = sealLocalChunk(reserveLocalChunk({ meetingId: 'meeting-1', segmentId: 'segment-1', chunkId: 'chunk-2', sequence: 2, startedAt: 10, byteSize: 5, checksum: 'sha256:two' }), { byteSize: 5, checksum: 'sha256:two', endedAt: 20 });
  const result = reconcileLocalMeetingChunks({
    manifest: [writing, sealed],
    files: [
      { path: writing.path, byteSize: 5, checksum: 'sha256:one', endedAt: 9 },
      { path: sealed.path, byteSize: 4, checksum: 'sha256:wrong' }
    ]
  });
  assert.equal(result.chunks[0].state, 'sealed');
  assert.equal(result.chunks[1].state, 'corrupt');
  assert.deepEqual(result.orphans, []);
});

test('reconciliation quarantines unreferenced OPFS files instead of deleting them', () => {
  const result = reconcileLocalMeetingChunks({
    manifest: [],
    files: [{ path: 'meetings/meeting-1/orphan.webm', byteSize: 4, checksum: 'sha256:orphan' }]
  });
  assert.deepEqual(result.orphans, [{ path: 'meetings/meeting-1/orphan.webm', byteSize: 4, checksum: 'sha256:orphan', state: 'orphan' }]);
});

test('in-memory manifest store is idempotent and rejects sequence conflicts', async () => {
  const store = createInMemoryLocalMeetingManifestStore();
  const input = { meetingId: 'meeting-1', segmentId: 'segment-1', chunkId: 'chunk-1', sequence: 1, startedAt: 0 };
  const first = await store.reserve(input);
  const repeated = await store.reserve(input);
  assert.equal(repeated.path, first.path);
  await assert.rejects(
    store.reserve({ ...input, chunkId: 'chunk-2' }),
    (error) => error.code === 'local_chunk_sequence_conflict' && error.status === 409
  );
  const sealed = await store.seal('chunk-1', { byteSize: 3, checksum: 'sha256:one', endedAt: 1 });
  assert.equal(sealed.state, 'sealed');
  const deleting = await store.mark('chunk-1', 'deleting');
  assert.equal(deleting.state, 'deleting');
  assert.equal((await store.list('meeting-1')).length, 1);
});

test('manifest duplicate chunk ids reject every immutable identity mismatch', async () => {
  const store = createInMemoryLocalMeetingManifestStore();
  const input = { meetingId: 'meeting-1', segmentId: 'segment-1', chunkId: 'chunk-1', sequence: 1, startedAt: 0 };
  await store.reserve(input);

  await assert.rejects(
    store.reserve({ ...input, segmentId: 'segment-2' }),
    (error) => error.code === 'local_chunk_identity_conflict'
  );
});

test('browser IndexedDB hydration projects and cleans credential-shaped pollution', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('https://local-recording.test/', (route) => route.fulfill({ body: '<!doctype html>' }));
  await page.goto('https://local-recording.test/');
  const source = await bundledLocalStorageSource();
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  const result = await page.evaluate(async ({ moduleUrl, dbName }) => {
    const { createIndexedDbLocalMeetingManifestStore } = await import(moduleUrl);
    const store = createIndexedDbLocalMeetingManifestStore({ indexedDBImpl: indexedDB, dbName });
    const reserved = await store.reserve({ meetingId: 'meeting-browser', segmentId: 'segment-1', chunkId: 'chunk-1', sequence: 1, startedAt: 0 });
    const database = await new Promise((resolve, reject) => { const request = indexedDB.open(dbName); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const { recordingId, ...legacy } = reserved;
    await new Promise((resolve, reject) => { const transaction = database.transaction('chunks', 'readwrite'); transaction.objectStore('chunks').put({ ...legacy, geminiApiKey: 'secret' }); transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error); });
    const hydrated = await store.get('chunk-1');
    const raw = await new Promise((resolve, reject) => { const transaction = database.transaction('chunks', 'readonly'); const request = transaction.objectStore('chunks').get('chunk-1'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    return { hydrated, raw };
  }, { moduleUrl, dbName: `local-meeting-${Date.now()}` });

  assert.equal(result.hydrated.geminiApiKey, undefined);
  assert.equal(result.hydrated.ephemeralToken, undefined);
  assert.equal(result.raw.geminiApiKey, undefined);
  assert.equal(result.raw.ephemeralToken, undefined);
});

test('browser IndexedDB retains translated audio manifest across reload and removes it at retention cleanup', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('https://local-audio-reload.test/', (route) => route.fulfill({ body: '<!doctype html>' }));
  await page.goto('https://local-audio-reload.test/');
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(await bundledLocalStorageSource()).toString('base64')}`;
  const dbName = `local-audio-${Date.now()}`;
  await page.evaluate(async ({ moduleUrl, dbName }) => {
    const { createIndexedDbLocalMeetingManifestStore } = await import(moduleUrl);
    const store = createIndexedDbLocalMeetingManifestStore({ indexedDBImpl: indexedDB, dbName });
    await store.saveTranslatedAudioChunk({ meetingId: 'meeting-a', sessionId: 'session-a', sequence: 1,
      byteSize: 4, checksum: 'sha256:test' });
  }, { moduleUrl, dbName });
  const otherProfile = await browser.newContext();
  t.after(() => otherProfile.close());
  const otherPage = await otherProfile.newPage();
  await otherPage.route('https://local-audio-reload.test/', (route) => route.fulfill({ body: '<!doctype html>' }));
  await otherPage.goto('https://local-audio-reload.test/');
  const otherProfileChunks = await otherPage.evaluate(async ({ moduleUrl, dbName }) => {
    const { createIndexedDbLocalMeetingManifestStore } = await import(moduleUrl);
    return createIndexedDbLocalMeetingManifestStore({ indexedDBImpl: indexedDB, dbName })
      .listTranslatedAudioChunks('meeting-a');
  }, { moduleUrl, dbName });
  assert.deepEqual(otherProfileChunks, []);
  await page.reload();
  const result = await page.evaluate(async ({ moduleUrl, dbName }) => {
    const { createIndexedDbLocalMeetingManifestStore } = await import(moduleUrl);
    const store = createIndexedDbLocalMeetingManifestStore({ indexedDBImpl: indexedDB, dbName });
    const before = await store.listTranslatedAudioChunks('meeting-a');
    const otherMeeting = await store.listTranslatedAudioChunks('meeting-b');
    await store.clearMeetingContent('meeting-a');
    return { before, otherMeeting, after: await store.listTranslatedAudioChunks('meeting-a') };
  }, { moduleUrl, dbName });
  assert.equal(result.before.length, 1);
  assert.equal(result.before[0].sessionId, 'session-a');
  assert.deepEqual(result.otherMeeting, []);
  assert.deepEqual(result.after, []);
});

test('browser OPFS translated PCM reloads as Host-only WAV and expires with retention', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('https://local-translated-audio.test/', (route) => route.fulfill({ body: '<!doctype html>' }));
  await page.goto('https://local-translated-audio.test/');
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(await bundledLocalPersistenceSource()).toString('base64')}`;
  const storageUrl = `data:text/javascript;base64,${Buffer.from(await bundledLocalStorageSource()).toString('base64')}`;
  const dbName = `local-translation-${Date.now()}`;
  await page.evaluate(async ({ moduleUrl, storageUrl, dbName }) => {
    const { createLocalMeetingPersistence } = await import(moduleUrl);
    const { createIndexedDbLocalMeetingManifestStore } = await import(storageUrl);
    const manifestStore = createIndexedDbLocalMeetingManifestStore({ indexedDBImpl: indexedDB, dbName });
    const persistence = createLocalMeetingPersistence({ manifestStore, recordAudio: false });
    await persistence.start({ meetingId: 'meeting-local', recordingId: 'session-local', segmentId: 'segment-local' });
    await persistence.appendTranslatedAudioChunk({ meetingId: 'meeting-local', sessionId: 'session-local', bytes: new Uint8Array([1, 0, 2, 0]) });
    await persistence.finalizeTranslatedAudio('meeting-local');
  }, { moduleUrl, storageUrl, dbName });
  await page.reload();
  const restored = await page.evaluate(async ({ moduleUrl, storageUrl, dbName }) => {
    const { createLocalMeetingPersistence } = await import(moduleUrl);
    const { createIndexedDbLocalMeetingManifestStore } = await import(storageUrl);
    const manifestStore = createIndexedDbLocalMeetingManifestStore({ indexedDBImpl: indexedDB, dbName });
    const persistence = createLocalMeetingPersistence({ manifestStore, recordAudio: false });
    const audio = await persistence.listFinalizedAudioArtifacts('meeting-local');
    await manifestStore.saveRetention({ meetingId: 'meeting-local', expiresAt: '2000-01-01T00:00:00.000Z' });
    let expiredCode = null;
    try { await persistence.listFinalizedAudioArtifacts('meeting-local'); } catch (error) { expiredCode = error.code; }
    return { kind: audio[0]?.kind, size: audio[0]?.blob.size, expiredCode };
  }, { moduleUrl, storageUrl, dbName });
  assert.deepEqual(restored, { kind: 'translation', size: 48, expiredCode: 'meeting_content_expired' });
});

test('browser IndexedDB reload replays lifecycle operations and OPFS refuses overwrite', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('https://local-recording-reload.test/', (route) => route.fulfill({ body: '<!doctype html>' }));
  await page.goto('https://local-recording-reload.test/');
  const storageSource = await bundledLocalStorageSource();
  const storageModuleUrl = `data:text/javascript;base64,${Buffer.from(storageSource).toString('base64')}`;
  const recorderSource = await readFile(new URL('../../src/lib/localMeetingRecorder.js', import.meta.url), 'utf8');
  const recorderModuleUrl = `data:text/javascript;base64,${Buffer.from(
    recorderSource.replace("'./localMeetingStorage.js'", JSON.stringify(storageModuleUrl))
  ).toString('base64')}`;

  const browserInput = {
    storageModuleUrl,
    recorderModuleUrl,
    dbName: `local-meeting-reload-${Date.now()}`
  };
  const recovered = await page.evaluate(async ({ storageModuleUrl, recorderModuleUrl, dbName }) => {
    const storageModule = await import(storageModuleUrl);
    const { createLocalMeetingRecorder } = await import(recorderModuleUrl);
    const firstRecorder = createLocalMeetingRecorder({
      manifestStore: storageModule.createIndexedDbLocalMeetingManifestStore({ indexedDBImpl: indexedDB, dbName }),
      chunkStore: storageModule.createOpfsChunkStore()
    });
    await firstRecorder.start('meeting-browser', { operationId: 'start-1' });
    await firstRecorder.pause({ operationId: 'pause-1' });
    return firstRecorder.recover({ operationId: 'recover-1' });
  }, browserInput);

  await page.reload();
  const afterRecoverReload = await page.evaluate(async ({ storageModuleUrl, recorderModuleUrl, dbName }) => {
    const storageModule = await import(storageModuleUrl);
    const { createLocalMeetingRecorder } = await import(recorderModuleUrl);
    const reloadedStore = storageModule.createIndexedDbLocalMeetingManifestStore({ indexedDBImpl: indexedDB, dbName });
    const chunkStore = storageModule.createOpfsChunkStore();
    const reloadedRecorder = createLocalMeetingRecorder({ manifestStore: reloadedStore, chunkStore });

    await reloadedRecorder.restore('meeting-browser');
    const replayedRecover = await reloadedRecorder.recover({ operationId: 'recover-1' });
    const finalized = await reloadedRecorder.finalize({ finalSequence: 0, operationId: 'finalize-1' });
    const opfsPath = `browser-reload/${dbName}/chunk.webm`;
    await chunkStore.write(opfsPath, new TextEncoder().encode('first'));

    await reloadedStore.commitRecordingOperation({
      recording: {
        meetingId: 'projection-browser', recordingId: 'recording-projection', segmentId: 'segment:recording-projection:1',
        segmentNumber: 1, captureEpoch: 1, providerEpoch: 0, state: 'capturing', terminal: false,
        finalized: false, geminiApiKey: 'secret'
      },
      operation: {
        meetingId: 'projection-browser', operationId: 'projection-1', type: 'recover', accessToken: 'secret',
        result: {
          state: 'capturing', meetingId: 'projection-browser', recordingId: 'recording-projection',
          segmentId: 'segment:recording-projection:1', captureEpoch: 1, providerEpoch: 0, apiKey: 'secret'
        }
      }
    });
    return { replayedRecover, finalized };
  }, browserInput);

  await page.reload();
  const afterFinalizeReload = await page.evaluate(async ({ storageModuleUrl, recorderModuleUrl, dbName }) => {
    const storageModule = await import(storageModuleUrl);
    const { createLocalMeetingRecorder } = await import(recorderModuleUrl);
    const finalStore = storageModule.createIndexedDbLocalMeetingManifestStore({ indexedDBImpl: indexedDB, dbName });
    const chunkStore = storageModule.createOpfsChunkStore();
    const finalRecorder = createLocalMeetingRecorder({ manifestStore: finalStore, chunkStore });
    await finalRecorder.restore('meeting-browser');
    const replayedFinalize = await finalRecorder.finalize({ finalSequence: 0, operationId: 'finalize-1' });
    let restartCode = null;
    try {
      await finalRecorder.start('meeting-browser', { operationId: 'start-2' });
    } catch (error) {
      restartCode = error.code;
    }

    const opfsPath = `browser-reload/${dbName}/chunk.webm`;
    let overwriteCode = null;
    try {
      await chunkStore.write(opfsPath, new TextEncoder().encode('second'));
    } catch (error) {
      overwriteCode = error.code;
    }
    const reopenedText = await (await chunkStore.read(opfsPath)).text();
    const projectedRecording = await finalStore.getRecording('projection-browser');
    const projectedOperation = await finalStore.getOperation('projection-browser', 'projection-1');
    return { replayedFinalize, restartCode, overwriteCode, reopenedText, projectedRecording, projectedOperation };
  }, browserInput);

  assert.deepEqual(afterRecoverReload.replayedRecover, recovered);
  assert.deepEqual(afterFinalizeReload.replayedFinalize, afterRecoverReload.finalized);
  assert.equal(afterFinalizeReload.restartCode, 'local_recorder_finalized');
  assert.equal(afterFinalizeReload.overwriteCode, 'local_chunk_file_exists');
  assert.equal(afterFinalizeReload.reopenedText, 'first');
  assert.equal(afterFinalizeReload.projectedRecording.geminiApiKey, undefined);
  assert.equal(afterFinalizeReload.projectedOperation.accessToken, undefined);
  assert.equal(afterFinalizeReload.projectedOperation.result.apiKey, undefined);
});

test('existing IndexedDB operations store persists one pending legacy Continue across reload', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('https://legacy-continue-reload.test/', (route) => route.fulfill({ body: '<!doctype html>' }));
  await page.goto('https://legacy-continue-reload.test/');
  const source = await bundledLocalStorageSource();
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  const dbName = `legacy-continue-${Date.now()}`;
  const operation = {
    operationId: 'continue-1',
    meetingId: 'meeting-1',
    sourceSegmentId: 'segment-1',
    nextLiveSessionId: 'live-2',
    payloadHash: 'hash-1',
    checkpoint: {},
    state: 'pending',
    attempt: 0,
    createdAt: '2026-10-10T00:00:00.000Z',
    updatedAt: '2026-10-10T00:00:00.000Z'
  };
  await page.evaluate(async ({ moduleUrl, dbName, operation }) => {
    const { createIndexedDbLocalMeetingManifestStore } = await import(moduleUrl);
    const store = createIndexedDbLocalMeetingManifestStore({ indexedDBImpl: indexedDB, dbName });
    await store.saveContinueOperation(operation);
  }, { moduleUrl, dbName, operation });
  await page.reload();
  const restored = await page.evaluate(async ({ moduleUrl, dbName }) => {
    const { createIndexedDbLocalMeetingManifestStore } = await import(moduleUrl);
    const store = createIndexedDbLocalMeetingManifestStore({ indexedDBImpl: indexedDB, dbName });
    return store.getPendingContinueOperation('meeting-1');
  }, { moduleUrl, dbName });
  assert.equal(restored.operationId, 'continue-1');
  assert.equal(restored.nextLiveSessionId, 'live-2');
  assert.equal(restored.state, 'pending');
});

test('browser public append seals an existing OPFS write after reload and rejects different bytes', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('https://local-append-reload.test/', (route) => route.fulfill({ body: '<!doctype html>' }));
  await page.goto('https://local-append-reload.test/');
  const storageSource = await bundledLocalStorageSource();
  const storageModuleUrl = `data:text/javascript;base64,${Buffer.from(storageSource).toString('base64')}`;
  const recorderSource = await readFile(new URL('../../src/lib/localMeetingRecorder.js', import.meta.url), 'utf8');
  const recorderModuleUrl = `data:text/javascript;base64,${Buffer.from(
    recorderSource.replace("'./localMeetingStorage.js'", JSON.stringify(storageModuleUrl))
  ).toString('base64')}`;
  const browserInput = {
    storageModuleUrl,
    recorderModuleUrl,
    dbName: `local-append-reload-${Date.now()}`
  };

  const crashWindow = await page.evaluate(async ({ storageModuleUrl, recorderModuleUrl, dbName }) => {
    const storageModule = await import(storageModuleUrl);
    const { createLocalMeetingRecorder } = await import(recorderModuleUrl);
    const manifestStore = storageModule.createIndexedDbLocalMeetingManifestStore({ indexedDBImpl: indexedDB, dbName });
    const chunkStore = storageModule.createOpfsChunkStore();
    const recorder = createLocalMeetingRecorder({ manifestStore, chunkStore });
    const started = await recorder.start('meeting-append-reload', { operationId: 'start-1' });
    const input = {
      meetingId: started.meetingId,
      recordingId: started.recordingId,
      segmentId: started.segmentId,
      chunkId: 'chunk-1',
      sequence: 1,
      startedAt: 10,
      endedAt: 20,
      byteSize: 5,
      checksum: 'sha256:browser-same',
      mimeType: 'audio/webm'
    };
    const reserved = await manifestStore.reserve(input);
    await chunkStore.write(reserved.path, new TextEncoder().encode('first'));
    return { input, path: reserved.path, state: (await manifestStore.get('chunk-1')).state };
  }, browserInput);
  assert.equal(crashWindow.state, 'writing');

  await page.reload();
  const result = await page.evaluate(async ({ storageModuleUrl, recorderModuleUrl, dbName, crashWindow }) => {
    const storageModule = await import(storageModuleUrl);
    const { createLocalMeetingRecorder } = await import(recorderModuleUrl);
    const manifestStore = storageModule.createIndexedDbLocalMeetingManifestStore({ indexedDBImpl: indexedDB, dbName });
    const chunkStore = storageModule.createOpfsChunkStore();
    const recorder = createLocalMeetingRecorder({ manifestStore, chunkStore });
    await recorder.restore('meeting-append-reload');
    const bytes = new TextEncoder().encode('first');
    const sealed = await recorder.appendChunk(crashWindow.input, bytes);
    const replayed = await recorder.appendChunk(crashWindow.input, bytes);
    let differentContentCode = null;
    try {
      await recorder.appendChunk(crashWindow.input, new TextEncoder().encode('other'));
    } catch (error) {
      differentContentCode = error.code;
    }
    const reopenedText = await (await chunkStore.read(crashWindow.path)).text();
    const root = await navigator.storage.getDirectory();
    const pathParts = crashWindow.path.split('/');
    pathParts.pop();
    let directory = root;
    for (const part of pathParts) directory = await directory.getDirectoryHandle(part);
    let fileCount = 0;
    for await (const _entry of directory.values()) fileCount += 1;
    return {
      sealed,
      replayed,
      persisted: await manifestStore.get('chunk-1'),
      differentContentCode,
      reopenedText,
      fileCount
    };
  }, { ...browserInput, crashWindow });

  assert.equal(result.sealed.state, 'sealed');
  assert.deepEqual(result.replayed, result.sealed);
  assert.equal(result.persisted.state, 'sealed');
  assert.equal(result.differentContentCode, 'local_chunk_content_conflict');
  assert.equal(result.reopenedText, 'first');
  assert.equal(result.fileCount, 1);
});

test('invalid state transitions do not silently rewrite sealed chunks', () => {
  const reserved = reserveLocalChunk({ meetingId: 'meeting-1', segmentId: 'segment-1', chunkId: 'chunk-1', sequence: 1, startedAt: 0 });
  const sealed = sealLocalChunk(reserved, { byteSize: 1, checksum: 'sha256:one', endedAt: 1 });
  assert.throws(() => markLocalChunk(sealed, 'writing'), (error) => error.code === 'local_chunk_state_conflict');
  assert.equal(sealLocalChunk(sealed, { byteSize: 1, checksum: 'sha256:one', endedAt: 1 }), sealed);
  assert.throws(() => sealLocalChunk(sealed, { byteSize: 2, checksum: 'sha256:other', endedAt: 1 }), (error) => error.code === 'local_chunk_seal_conflict');
});
test('browser IndexedDB restores metadata-only lifecycle intent after reload', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('https://lifecycle-intent-reload.test/', (route) => route.fulfill({ body: '<!doctype html>' }));
  await page.goto('https://lifecycle-intent-reload.test/');
  const source = await bundledLocalStorageSource();
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  const dbName = `lifecycle-intent-${Date.now()}`;
  await page.evaluate(async ({ moduleUrl, dbName }) => {
    const { createIndexedDbLocalMeetingManifestStore } = await import(moduleUrl);
    const store = createIndexedDbLocalMeetingManifestStore({ indexedDBImpl: indexedDB, dbName });
    await store.saveLifecycleIntent({
      ownerUserId: 'owner-1', meetingId: 'meeting-1', sessionId: 'session-1',
      segmentId: 'segment-1', originalOperationId: 'operation-1',
      currentOperationId: 'operation-1', command: 'stop',
      expectedLifecycleVersion: 3, leaseId: 'lease-1', fenceToken: 2,
      leaseExpiresAt: '2030-01-01T00:00:00.000Z', payload: {},
      status: 'unknown'
    });
  }, { moduleUrl, dbName });
  await page.reload();
  const result = await page.evaluate(async ({ moduleUrl, dbName }) => {
    const { createIndexedDbLocalMeetingManifestStore } = await import(moduleUrl);
    const store = createIndexedDbLocalMeetingManifestStore({ indexedDBImpl: indexedDB, dbName });
    const existing = (await store.listPendingLifecycleIntents('owner-1', 'meeting-1'))[0];
    await store.saveLifecycleIntent(existing);
    const identityErrors = [];
    for (const change of [{ sessionId: 'session-2' }, { segmentId: 'segment-2' }]) {
      try {
        await store.saveLifecycleIntent({ ...existing, ...change });
      } catch (error) {
        identityErrors.push(error.code);
      }
    }
    return {
      pending: await store.listPendingLifecycleIntents('owner-1', 'meeting-1'),
      otherOwner: await store.listPendingLifecycleIntents('owner-2', 'meeting-1'),
      otherMeeting: await store.listPendingLifecycleIntents('owner-1', 'meeting-2'),
      identityErrors
    };
  }, { moduleUrl, dbName });
  assert.equal(result.pending.length, 1);
  assert.equal(result.pending[0].originalOperationId, 'operation-1');
  assert.equal(result.pending[0].status, 'unknown');
  assert.deepEqual(result.pending[0].payload, {});
  assert.deepEqual(result.otherOwner, []);
  assert.deepEqual(result.otherMeeting, []);
  assert.deepEqual(result.identityErrors, ['local_lifecycle_intent_conflict', 'local_lifecycle_intent_conflict']);
});

test('lifecycle intent identity is immutable across idempotent writes and absent IDs', () => {
  const store = createInMemoryLocalMeetingManifestStore();
  const intent = {
    ownerUserId: 'owner-1', meetingId: 'meeting-1', sessionId: 'session-1',
    segmentId: 'segment-1', originalOperationId: 'operation-1',
    command: 'stop', expectedLifecycleVersion: 3, payload: {}, status: 'prepared'
  };
  store.saveLifecycleIntent(intent);
  store.saveLifecycleIntent({ ...intent, status: 'submitted' });
  for (const change of [
    { sessionId: 'session-2' }, { segmentId: 'segment-2' },
    { sessionId: null }, { segmentId: undefined }
  ]) {
    assert.throws(() => store.saveLifecycleIntent({ ...intent, ...change }),
      (error) => error.code === 'local_lifecycle_intent_conflict');
  }
  const { key } = store.getLifecycleIntent('owner-1', 'meeting-1', 'operation-1');
  for (const change of [
    { ownerUserId: 'owner-2' }, { meetingId: 'meeting-2' },
    { originalOperationId: 'operation-3' }
  ]) {
    assert.throws(() => store.saveLifecycleIntent({ ...intent, key, ...change }),
      /key does not match its scope/u);
  }
  const pending = store.getLifecycleIntent('owner-1', 'meeting-1', 'operation-1');
  assert.equal(pending.status, 'submitted');
  assert.equal(pending.sessionId, 'session-1');
  assert.equal(pending.segmentId, 'segment-1');

  const unknown = { ...intent, originalOperationId: 'operation-2',
    sessionId: null, segmentId: undefined };
  store.saveLifecycleIntent(unknown);
  assert.throws(() => store.saveLifecycleIntent({ ...unknown, sessionId: 'session-2' }),
    (error) => error.code === 'local_lifecycle_intent_conflict');
  assert.throws(() => store.saveLifecycleIntent({ ...unknown, segmentId: 'segment-2' }),
    (error) => error.code === 'local_lifecycle_intent_conflict');
  assert.equal(store.getLifecycleIntent('owner-1', 'meeting-1', 'operation-2').segmentId, null);
});

test('IndexedDB reload adopts committed Stop and Rollover without resubmitting', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('https://lifecycle-result-reload.test/', (route) => route.fulfill({ body: '<!doctype html>' }));
  await page.goto('https://lifecycle-result-reload.test/');
  const storageUrl = `data:text/javascript;base64,${Buffer.from(await bundledLocalStorageSource()).toString('base64')}`;
  const recoveryUrl = `data:text/javascript;base64,${Buffer.from(await bundledLifecycleRecoverySource()).toString('base64')}`;
  const dbName = `lifecycle-result-${Date.now()}`;
  await page.evaluate(async ({ storageUrl, recoveryUrl, dbName }) => {
    const { createIndexedDbLocalMeetingManifestStore } = await import(storageUrl);
    const { createLifecycleRecoveryController } = await import(recoveryUrl);
    const store = createIndexedDbLocalMeetingManifestStore({ indexedDBImpl: indexedDB, dbName });
    const api = {
      async executeRecordingCommand() { throw new Error('response lost'); },
      async lookupRecordingOperation() { throw new Error('must not look up before reload'); },
      async recoverRecordingLease() { throw new Error('must not recover lease'); }
    };
    const controller = createLifecycleRecoveryController({ store, api });
    for (const command of ['stop', 'rollover']) {
      try {
        await controller.submit({ ownerUserId: 'owner-1', meetingId: `meeting-${command}`,
          command, operationId: `operation-${command}`, expectedLifecycleVersion: 1,
          sessionId: 'session-1', segmentId: 'segment-1', leaseId: 'lease-1',
          fenceToken: 1, leaseExpiresAt: '2030-01-01T00:00:00.000Z',
          payload: command === 'rollover' ? { nextLiveSessionId: 'live-next' } : {} });
      } catch (error) {
        if (error.message !== 'response lost') throw error;
      }
    }
  }, { storageUrl, recoveryUrl, dbName });
  await page.reload();
  const result = await page.evaluate(async ({ storageUrl, recoveryUrl, dbName }) => {
    const { createIndexedDbLocalMeetingManifestStore } = await import(storageUrl);
    const { createLifecycleRecoveryController } = await import(recoveryUrl);
    const store = createIndexedDbLocalMeetingManifestStore({ indexedDBImpl: indexedDB, dbName });
    let resubmissions = 0;
    const api = {
      async executeRecordingCommand() { resubmissions += 1; throw new Error('duplicate submit'); },
      async lookupRecordingOperation({ operationId }) {
        const stop = operationId === 'operation-stop';
        return { status: 'committed', operationId, command: stop ? 'stop' : 'rollover',
          resultingLifecycleVersion: 2, targetIdentityRecorded: true,
          targetSessionId: 'session-1', targetSegmentId: 'segment-1',
          sessionId: 'session-1', segmentId: stop ? null : 'segment-2' };
      },
      async recoverRecordingLease() { throw new Error('must not recover lease'); }
    };
    const controller = createLifecycleRecoveryController({ store, api });
    const statuses = [];
    for (const command of ['stop', 'rollover']) {
      const meetingId = `meeting-${command}`;
      statuses.push((await controller.recover({ ownerUserId: 'owner-1', meetingId })).status);
      statuses.push((await store.getLifecycleIntent('owner-1', meetingId, `operation-${command}`)).status);
    }
    return { statuses, resubmissions };
  }, { storageUrl, recoveryUrl, dbName });
  assert.deepEqual(result.statuses, ['committed', 'committed', 'committed', 'committed']);
  assert.equal(result.resubmissions, 0);
});

test('browser IndexedDB commits Segment predecessor, successor, pointer and operation atomically', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('https://local-segment-ledger.test/', (route) => route.fulfill({ body: '<!doctype html>' }));
  await page.goto('https://local-segment-ledger.test/');
  const storageUrl = `data:text/javascript;base64,${Buffer.from(await bundledLocalStorageSource()).toString('base64')}`;
  const dbName = `segment-ledger-${Date.now()}`;
  const beforeReload = await page.evaluate(async ({ storageUrl, dbName }) => {
    const { createIndexedDbLocalMeetingManifestStore } = await import(storageUrl);
    const store = createIndexedDbLocalMeetingManifestStore({ indexedDBImpl: indexedDB, dbName });
    const recording = { meetingId: 'meeting-1', recordingId: 'recording-1', segmentId: 'segment-1',
      segmentNumber: 1, captureEpoch: 1, providerEpoch: 0, state: 'capturing',
      integrityVersion: 2, pcmEnabled: true };
    await store.commitRecordingOperation({ recording, operation: {
      meetingId: 'meeting-1', operationId: 'start-1', type: 'start', result: recording
    } });
    const transition = { meetingId: 'meeting-1', recordingId: 'recording-1', operationId: 'rollover-1',
      predecessorId: 'segment-1', predecessorSequence: 1, successorId: 'segment-2', successorSequence: 2 };
    await store.prepareSegmentTransition(transition);
    let invalidCode = null;
    try { await store.commitSegmentTransition({ ...transition, boundary: { recordingId: 'wrong' } }); }
    catch (error) { invalidCode = error.code; }
    const before = { recording: await store.getRecording('meeting-1'),
      segments: await store.listSegments('meeting-1'),
      operation: await store.getSegmentTransition('meeting-1', 'rollover-1') };
    const boundary = { recordingId: 'recording-1', transitionOperationId: 'rollover-1',
      captureEpoch: 2, endSample: 1600, offset: 42, sha256: 'a'.repeat(64) };
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, ...args) {
      if (this.name === 'recordings' && value.segmentId === 'segment-2') {
        throw new Error('SIMULATED_IDB_WRITE_FAILURE');
      }
      return originalPut.call(this, value, ...args);
    };
    let writeFailure = null;
    try { await store.commitSegmentTransition({ ...transition, boundary }); }
    catch (error) { writeFailure = error.message; }
    finally { IDBObjectStore.prototype.put = originalPut; }
    const afterFailedWrite = { recording: await store.getRecording('meeting-1'),
      segments: await store.listSegments('meeting-1'),
      operation: await store.getSegmentTransition('meeting-1', 'rollover-1') };
    await store.commitSegmentTransition({ ...transition, boundary });
    await store.saveRetention({ meetingId: 'meeting-1', recordingId: 'recording-1',
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() });
    return { invalidCode, before, writeFailure, afterFailedWrite };
  }, { storageUrl, dbName });
  assert.equal(beforeReload.invalidCode, 'local_segment_boundary_invalid');
  assert.equal(beforeReload.before.recording.segmentId, 'segment-1');
  assert.deepEqual(beforeReload.before.segments.map((segment) => segment.status), ['ACTIVE']);
  assert.equal(beforeReload.before.operation.phase, 'PREPARED');
  assert.equal(beforeReload.writeFailure, 'SIMULATED_IDB_WRITE_FAILURE');
  assert.equal(beforeReload.afterFailedWrite.recording.segmentId, 'segment-1');
  assert.equal(beforeReload.afterFailedWrite.recording.captureEpoch, 1);
  assert.deepEqual(beforeReload.afterFailedWrite.segments.map((segment) => segment.status), ['ACTIVE']);
  assert.equal(beforeReload.afterFailedWrite.operation.phase, 'PREPARED');
  await page.reload();
  const restored = await page.evaluate(async ({ storageUrl, dbName }) => {
    const { createIndexedDbLocalMeetingManifestStore } = await import(storageUrl);
    const store = createIndexedDbLocalMeetingManifestStore({ indexedDBImpl: indexedDB, dbName });
    const recording = await store.getRecording('meeting-1');
    const segments = await store.listSegments('meeting-1');
    const operation = await store.getSegmentTransition('meeting-1', 'rollover-1');
    const retention = await store.getRetention('meeting-1');
    await store.clearMeetingContent('meeting-1');
    return { recording, segments, operation, retention,
      afterClear: await store.listSegments('meeting-1') };
  }, { storageUrl, dbName });
  assert.equal(restored.recording.segmentId, 'segment-2');
  assert.equal(restored.recording.captureEpoch, 3);
  assert.equal(restored.operation.result.captureEpoch, 3);
  assert.deepEqual(restored.segments.map((segment) => [segment.status, segment.firstJournalEpoch,
    segment.lastJournalEpoch]), [['ENDED', 1, 2], ['ACTIVE', 3, null]]);
  assert.equal(restored.operation.phase, 'COMMITTED');
  assert.equal(restored.retention.deleted, false);
  assert.ok(Date.parse(restored.retention.expiresAt) > Date.now());
  assert.deepEqual(restored.afterClear, []);
});
