import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalMeetingPersistence } from '../../src/lib/localMeetingPersistence.js';
import { createInMemoryLocalMeetingManifestStore } from '../../src/lib/localMeetingStorage.js';

test('translated OPFS failure preserves earlier chunks and disables later writes across pause and reload', async () => {
  const manifestStore = createInMemoryLocalMeetingManifestStore();
  const files = new Map();
  const writes = [];
  const failure = new DOMException('private storage path', 'UnknownError');
  const chunkStore = {
    async write(path, bytes) {
      writes.push(path);
      if (writes.length === 2) throw failure;
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
  assert.deepEqual(results.map((result) => result.status), ['fulfilled', 'rejected', 'fulfilled']);
  assert.equal(results[1].reason, failure);
  assert.equal(writes.length, 2);
  assert.deepEqual((await manifestStore.listTranslatedAudioChunks('m1')).map((chunk) => chunk.sequence), [1]);
  await persistence.appendAudioChunk({ data: new Blob(['input'], { type: 'audio/webm' }),
    mimeType: 'audio/webm', receivedAt: 10 });
  assert.equal((await manifestStore.list('m1')).length, 1);
  await persistence.pause();
  assert.equal(await persistence.sealSegmentWrites('m1'), true);
  assert.equal((await persistence.finalizeTranslatedAudio('m1')).status, 'unavailable');

  const reloaded = create();
  assert.equal((await reloaded.finalizeTranslatedAudio('m1')).status, 'unavailable');
    assert.deepEqual(await reloaded.listFinalizedAudioArtifactMetadata('m1'), []);
  assert.deepEqual(await reloaded.listFinalizedAudioArtifacts('m1', { kind: 'translation' }), []);
  assert.deepEqual((await manifestStore.listTranslatedAudioChunks('m1')).map((chunk) => chunk.sequence), [1]);
  assert.deepEqual([...files.entries()]
    .filter(([path]) => path.includes('/translated-audio/'))
    .map(([, bytes]) => [...bytes]), [[1, 0]]);
});

test('failed availability update leaves pending audio unavailable after reload', async () => {
  const base = createInMemoryLocalMeetingManifestStore();
  const manifestStore = {
    ...base,
    async setTranslatedAudioAvailability(meetingId, status) {
      if (status === 'unavailable') throw new DOMException('metadata unavailable', 'UnknownError');
      return base.setTranslatedAudioAvailability(meetingId, status);
    }
  };
  const failure = new DOMException('OPFS unavailable', 'UnknownError');
  let writes = 0;
  const chunkStore = {
    async write() { writes += 1; if (writes === 2) throw failure; },
    async read() { return new Blob([new Uint8Array([1, 0])]); }
  };
  const create = () => createLocalMeetingPersistence({ manifestStore, chunkStore,
    cryptoImpl: { subtle: { async digest(_algorithm, bytes) { return new Uint8Array(bytes).buffer; } } } });
  const first = create();
  await first.start({ meetingId: 'm1', recordingId: 's1', segmentId: 'segment-1' });
  await first.appendTranslatedAudioChunk({ meetingId: 'm1', sessionId: 's1', bytes: new Uint8Array([1, 0]) });
  await assert.rejects(first.appendTranslatedAudioChunk({ meetingId: 'm1', sessionId: 's1', bytes: new Uint8Array([2, 0]) }),
    (error) => error === failure);
  await first.appendTranslatedAudioChunk({ meetingId: 'm1', sessionId: 's1', bytes: new Uint8Array([3, 0]) });
  assert.equal(writes, 2);
  assert.equal(await base.getTranslatedAudioAvailability('m1'), 'pending');
  assert.equal((await create().finalizeTranslatedAudio('m1')).status, 'unavailable');
  assert.deepEqual(await create().listFinalizedAudioArtifactMetadata('m1'), []);
  assert.deepEqual(await create().listFinalizedAudioArtifacts('m1', { kind: 'translation' }), []);
  assert.deepEqual((await base.listTranslatedAudioChunks('m1')).map((chunk) => chunk.sequence), [1]);
});

test('manifest failure rejects translated chunk and leaves no saved metadata', async () => {
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
  assert.deepEqual(await persistence.listFinalizedAudioArtifactMetadata('m2'), []);
});
