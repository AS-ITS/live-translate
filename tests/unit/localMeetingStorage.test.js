import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { chromium } from '@playwright/test';
import {
  buildLocalChunkPath,
  createIndexedDbLocalMeetingManifestStore,
  createInMemoryLocalMeetingManifestStore,
  markLocalChunk,
  reconcileLocalMeetingChunks,
  reserveLocalChunk,
  sealLocalChunk
} from '../../src/lib/localMeetingStorage.js';

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
  const source = await readFile(new URL('../../src/lib/localMeetingStorage.js', import.meta.url), 'utf8');
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

test('browser IndexedDB reload replays lifecycle operations and OPFS refuses overwrite', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('https://local-recording-reload.test/', (route) => route.fulfill({ body: '<!doctype html>' }));
  await page.goto('https://local-recording-reload.test/');
  const storageSource = await readFile(new URL('../../src/lib/localMeetingStorage.js', import.meta.url), 'utf8');
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

test('browser public append seals an existing OPFS write after reload and rejects different bytes', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('https://local-append-reload.test/', (route) => route.fulfill({ body: '<!doctype html>' }));
  await page.goto('https://local-append-reload.test/');
  const storageSource = await readFile(new URL('../../src/lib/localMeetingStorage.js', import.meta.url), 'utf8');
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
