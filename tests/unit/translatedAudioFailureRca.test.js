import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalMeetingPersistence } from '../../src/lib/localMeetingPersistence.js';
import { createInMemoryLocalMeetingManifestStore, createOpfsChunkStore } from '../../src/lib/localMeetingStorage.js';
import { getAudioDiagnosticSnapshot, recordAudioFailure } from '../../src/lib/audioFailureDiagnostic.js';

test('OPFS write preserves UnknownError and identifies the failing browser operation', async () => {
  for (const [failingOperation, errorName] of [
    'PARENT_DIRECTORY', 'FILE_LOOKUP', 'FILE_CREATE',
    'WRITABLE_CREATE', 'WRITABLE_WRITE', 'WRITABLE_CLOSE'
  ].map((operation) => [operation, 'UnknownError']).concat([['WRITABLE_WRITE', 'InvalidStateError']])) {
    const failure = new DOMException('private storage path', errorName);
    const writable = {
      async write() { if (failingOperation === 'WRITABLE_WRITE') throw failure; },
      async close() { if (failingOperation === 'WRITABLE_CLOSE') throw failure; },
      async abort() {}
    };
    const directory = {
      async getDirectoryHandle() {
        if (failingOperation === 'PARENT_DIRECTORY') throw failure;
        return directory;
      },
      async getFileHandle(_name, { create } = {}) {
        if (!create) {
          if (failingOperation === 'FILE_LOOKUP') throw failure;
          throw new DOMException('absent', 'NotFoundError');
        }
        if (failingOperation === 'FILE_CREATE') throw failure;
        return { async createWritable() {
          if (failingOperation === 'WRITABLE_CREATE') throw failure;
          return writable;
        } };
      }
    };
    const store = createOpfsChunkStore({ rootDirectory: directory });
    await assert.rejects(store.write('meetings/m1/translated-audio/s1/00000001.pcm', new Uint8Array([1, 0])),
      (error) => error === failure && error.name === errorName && error.opfsOperation === failingOperation);
  }
});

test('PARENT_DIRECTORY distinguishes root lookup from child directory lookup', async () => {
  const path = 'meetings/m1/translated-audio/s1/00000001.pcm';
  const rootFailure = new DOMException('private root detail', 'UnknownError');
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { storage: { async getDirectory() { throw rootFailure; } } }
  });
  try {
    await assert.rejects(createOpfsChunkStore().write(path, new Uint8Array([1, 0])),
      (error) => error === rootFailure && error.opfsOperation === 'PARENT_DIRECTORY'
        && error.opfsApi === 'GET_DIRECTORY');
    recordAudioFailure({ audioPath: 'TRANSLATED_AUDIO', stage: 'AUDIO_CHUNK_WRITE', error: rootFailure });
    assert.deepEqual(getAudioDiagnosticSnapshot().events.at(-1)?.storageOperation, 'PARENT_DIRECTORY');
    assert.deepEqual(getAudioDiagnosticSnapshot().events.at(-1)?.storageApi, 'GET_DIRECTORY');
    assert.deepEqual(getAudioDiagnosticSnapshot().events.at(-1)?.errorOrigin, 'DOM_EXCEPTION');
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else delete globalThis.navigator;
  }
  const childFailure = new DOMException('private child detail', 'UnknownError');
  const root = { async getDirectoryHandle() { throw childFailure; } };
  await assert.rejects(createOpfsChunkStore({ rootDirectory: root }).write(path, new Uint8Array([1, 0])),
    (error) => error === childFailure && error.opfsOperation === 'PARENT_DIRECTORY'
      && error.opfsApi === 'GET_DIRECTORY_HANDLE');
  recordAudioFailure({ audioPath: 'TRANSLATED_AUDIO', stage: 'AUDIO_CHUNK_WRITE', error: childFailure });
  const event = getAudioDiagnosticSnapshot().events.at(-1);
  assert.equal(event.storageOperation, 'PARENT_DIRECTORY');
  assert.equal(event.storageApi, 'GET_DIRECTORY_HANDLE');
  assert.equal(event.errorOrigin, 'DOM_EXCEPTION');
  assert.doesNotMatch(JSON.stringify(event), /private|stack|message/u);
});

test('OPFS write failure reaches Issue 41 log and audio panel snapshot', async () => {
  const failure = new DOMException('private subtitle and audio', 'UnknownError');
  const directory = {
    async getDirectoryHandle() { return directory; },
    async getFileHandle(_name, { create } = {}) {
      if (!create) throw new DOMException('absent', 'NotFoundError');
      return { async createWritable() {
        return {
          async write() { throw failure; },
          async abort() {}
        };
      } };
    }
  };
  const persistence = createLocalMeetingPersistence({
    manifestStore: createInMemoryLocalMeetingManifestStore(),
    chunkStore: createOpfsChunkStore({ rootDirectory: directory }),
    cryptoImpl: { subtle: { async digest(_algorithm, bytes) { return new Uint8Array(bytes).buffer; } } }
  });
  const originalInfo = console.info;
  const entries = [];
  console.info = (...args) => entries.push(args);
  try {
    await persistence.start({ meetingId: 'm1', recordingId: 's1', segmentId: 'segment-1' });
    await assert.rejects(persistence.appendTranslatedAudioChunk({
      meetingId: 'm1', sessionId: 's1', bytes: new Uint8Array([1, 0])
    }), (error) => error === failure);
  } finally {
    console.info = originalInfo;
  }
  const detail = entries.find(([label]) => label === 'ISSUE41_AUDIO_FAILURE')?.[1];
  assert.equal(detail?.audioPath, 'TRANSLATED_AUDIO');
  assert.equal(detail?.stage, 'AUDIO_CHUNK_WRITE');
  assert.equal(detail?.storageOperation, 'WRITABLE_WRITE');
  assert.equal(detail?.errorOrigin, 'DOM_EXCEPTION');
  assert.equal(detail?.errorName, 'UnknownError');
  const event = getAudioDiagnosticSnapshot().events.at(-1);
  assert.equal(event.storageOperation, 'WRITABLE_WRITE');
  assert.equal(event.errorOrigin, 'DOM_EXCEPTION');
  assert.doesNotMatch(JSON.stringify({ detail, event }), /private|subtitle|stack|message/iu);
});

test('failed translated chunk is not retried or marked saved; later chunks remain ordered across pause and reload', async () => {
  const manifestStore = createInMemoryLocalMeetingManifestStore();
  const files = new Map();
  const writes = [];
  const failure = new DOMException('private storage path', 'UnknownError');
  const chunkStore = {
    async write(path, bytes) {
      writes.push(path);
      if (writes.length === 1) throw failure;
      files.set(path, new Uint8Array(bytes));
    },
    async read(path) { return new Blob([files.get(path)]); }
  };
  const cryptoImpl = { subtle: { async digest(_algorithm, bytes) { return new Uint8Array(bytes).buffer; } } };
  const create = () => createLocalMeetingPersistence({ manifestStore, chunkStore, cryptoImpl });
  const persistence = create();
  await persistence.start({ meetingId: 'm1', recordingId: 's1', segmentId: 'segment-1' });
  const chunks = [new Uint8Array([1, 0]), new Uint8Array([2, 0]), new Uint8Array([3, 0])];
  const results = await Promise.allSettled(chunks.map((bytes) => persistence.appendTranslatedAudioChunk({
    meetingId: 'm1', sessionId: 's1', bytes
  })));
  assert.deepEqual(results.map((result) => result.status), ['rejected', 'fulfilled', 'fulfilled']);
  assert.equal(results[0].reason, failure);
  assert.equal(writes.length, 3);
  assert.deepEqual((await manifestStore.listTranslatedAudioChunks('m1')).map((chunk) => chunk.sequence), [2, 3]);
  await persistence.appendAudioChunk({ data: new Blob(['input'], { type: 'audio/webm' }),
    mimeType: 'audio/webm', receivedAt: 10 });
  assert.equal((await manifestStore.list('m1')).length, 1);
  await persistence.pause();
  await assert.rejects(persistence.finalizeTranslatedAudio('m1'), (error) => error === failure);

  const reloaded = create();
    await assert.rejects(reloaded.finalizeTranslatedAudio('m1'),
      (error) => error.code === 'INTEGRITY_UNRESOLVED');
    assert.deepEqual(await reloaded.listFinalizedAudioArtifactMetadata('m1'), []);
    await assert.rejects(reloaded.listFinalizedAudioArtifacts('m1', { kind: 'translation' }),
      (error) => error.code === 'INTEGRITY_UNRESOLVED');
  assert.deepEqual((await manifestStore.listTranslatedAudioChunks('m1')).map((chunk) => chunk.sequence), [2, 3]);
  assert.deepEqual([...files.entries()]
    .filter(([path]) => path.includes('/translated-audio/'))
    .map(([, bytes]) => [...bytes]), [[2, 0], [3, 0]]);
});

test('manifest UnknownError is classified as segment commit, after the OPFS write', async () => {
  const base = createInMemoryLocalMeetingManifestStore();
  const failure = new DOMException('private IndexedDB detail', 'UnknownError');
  const manifestStore = { ...base, async saveTranslatedAudioChunk() { throw failure; } };
  const files = new Map();
  const chunkStore = {
    async write(path, bytes) { files.set(path, new Uint8Array(bytes)); },
    async read(path) { return new Blob([files.get(path)]); }
  };
  const cryptoImpl = { subtle: { async digest(_algorithm, bytes) { return new Uint8Array(bytes).buffer; } } };
  const persistence = createLocalMeetingPersistence({ manifestStore, chunkStore, cryptoImpl });
  await persistence.start({ meetingId: 'm2', recordingId: 's2', segmentId: 'segment-2' });
  await assert.rejects(persistence.appendTranslatedAudioChunk({
    meetingId: 'm2', sessionId: 's2', bytes: new Uint8Array([1, 0])
  }), (error) => error === failure);
  assert.equal(files.size, 1);
  assert.deepEqual(await base.listTranslatedAudioChunks('m2'), []);
  const event = getAudioDiagnosticSnapshot().events.at(-1);
  assert.equal(event.stage, 'AUDIO_SEGMENT_COMMIT');
  assert.equal(event.storageOperation, null);
  assert.equal(event.errorOrigin, 'DOM_EXCEPTION');
});
