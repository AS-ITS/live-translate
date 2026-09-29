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

test('invalid state transitions do not silently rewrite sealed chunks', () => {
  const reserved = reserveLocalChunk({ meetingId: 'meeting-1', segmentId: 'segment-1', chunkId: 'chunk-1', sequence: 1, startedAt: 0 });
  const sealed = sealLocalChunk(reserved, { byteSize: 1, checksum: 'sha256:one', endedAt: 1 });
  assert.throws(() => markLocalChunk(sealed, 'writing'), (error) => error.code === 'local_chunk_state_conflict');
  assert.equal(sealLocalChunk(sealed, { byteSize: 1, checksum: 'sha256:one', endedAt: 1 }), sealed);
  assert.throws(() => sealLocalChunk(sealed, { byteSize: 2, checksum: 'sha256:other', endedAt: 1 }), (error) => error.code === 'local_chunk_seal_conflict');
});
