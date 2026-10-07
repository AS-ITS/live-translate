import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

test('real browser persists deadline over reload and coordinates OPFS/IDB cleanup across tabs', async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext();
  const origin = 'https://retention-browser.test/';
  await context.route(origin, (route) => route.fulfill({ body: '<!doctype html><title>Retention</title>' }));
  const storageSource = await readFile(new URL('../../src/lib/localMeetingStorage.js', import.meta.url), 'utf8');
  const storageUrl = `data:text/javascript;base64,${Buffer.from(storageSource).toString('base64')}`;
  const retentionSource = await readFile(new URL('../../src/lib/localMeetingRetention.js', import.meta.url), 'utf8');
  const retentionUrl = `data:text/javascript;base64,${Buffer.from(
    retentionSource.replace("'./localMeetingStorage.js'", JSON.stringify(storageUrl))
  ).toString('base64')}`;
  const dbName = `retention-${Date.now()}`;
  const pageA = await context.newPage();
  await pageA.goto(origin);
  await pageA.evaluate(async ({ storageUrl, dbName }) => {
    const { createIndexedDbLocalMeetingManifestStore, createOpfsChunkStore } = await import(storageUrl);
    const store = createIndexedDbLocalMeetingManifestStore({ indexedDBImpl: indexedDB, dbName });
    const chunkStore = createOpfsChunkStore();
    const chunk = await store.reserve({ meetingId: 'meeting-browser', recordingId: 'capture-browser',
      segmentId: 'segment-1', chunkId: 'chunk-1', sequence: 1, startedAt: 0 });
    await chunkStore.write(chunk.path, new TextEncoder().encode('audio'));
    await store.saveRetention({ meetingId: 'meeting-browser', recordingId: 'capture-browser',
      expiresAt: new Date(200).toISOString(), seenInCloud: true });
  }, { storageUrl, dbName });
  await pageA.reload();
  const pageB = await context.newPage();
  await pageB.goto(origin);
  const evaluateCleanup = async (page) => page.evaluate(async ({ storageUrl, retentionUrl, dbName }) => {
    const { createIndexedDbLocalMeetingManifestStore, createOpfsChunkStore } = await import(storageUrl);
    const { createLocalMeetingRetention } = await import(retentionUrl);
    const store = createIndexedDbLocalMeetingManifestStore({ indexedDBImpl: indexedDB, dbName });
    const retention = createLocalMeetingRetention({ manifestStore: store,
      chunkStore: createOpfsChunkStore(), locks: navigator.locks, now: () => 200 });
    return retention.check();
  }, { storageUrl, retentionUrl, dbName });
  await Promise.all([evaluateCleanup(pageA), evaluateCleanup(pageB)]);
  const actual = await pageA.evaluate(async ({ storageUrl, dbName }) => {
    const { createIndexedDbLocalMeetingManifestStore } = await import(storageUrl);
    const store = createIndexedDbLocalMeetingManifestStore({ indexedDBImpl: indexedDB, dbName });
    const root = await navigator.storage.getDirectory();
    let opfsExists = true;
    try {
      const meetings = await root.getDirectoryHandle('meetings');
      await meetings.getDirectoryHandle('meeting-browser');
    } catch (error) {
      if (error.name === 'NotFoundError') opfsExists = false;
      else throw error;
    }
    return { retention: await store.getRetention('meeting-browser'),
      chunks: await store.list('meeting-browser'), opfsExists };
  }, { storageUrl, dbName });
  assert.equal(actual.retention.recordingId, 'capture-browser');
  assert.equal(actual.retention.physicalCleared, true);
  assert.deepEqual(actual.chunks, []);
  assert.equal(actual.opfsExists, false);
});
