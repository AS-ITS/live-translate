import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { rolldown } from 'rolldown';
import { createLocalMeetingPersistence } from '../../src/lib/localMeetingPersistence.js';
import { createInMemoryLocalMeetingManifestStore } from '../../src/lib/localMeetingStorage.js';
import { createMeetingCheckpointSyncCoordinator } from '../../src/lib/meetingCheckpointSyncCoordinator.js';

const meetingId = 'checkpoint-contract-meeting';
const segmentId = 'checkpoint-contract-segment';
const finalCue = {
  cueId: 'cue-1', sessionId: 'session-1', segmentId, sequence: 1,
  startTimeMs: 100, endTimeMs: 150,
  sourceLanguageCode: 'en', targetLanguageCode: 'fr',
  status: 'final', sourceText: 'hello', translatedText: 'bonjour',
  finalizedReason: 'turnComplete'
};
const cueCheckpoint = { nextSequence: 2 };

async function createFixture(manifestStore = createInMemoryLocalMeetingManifestStore()) {
  const persistence = createLocalMeetingPersistence({
    manifestStore, cryptoImpl: webcrypto, recordAudio: false, trace: () => {}
  });
  await persistence.saveCue({ meetingId, segmentId, sessionId: finalCue.sessionId, cue: finalCue });
  const returned = [];
  const coordinator = createMeetingCheckpointSyncCoordinator({
    updateCheckpoint: async (payload) => {
      const saved = await persistence.updateCheckpoint(payload);
      returned.push(saved);
      return saved;
    },
    getCheckpoint: (scope) => persistence.getCheckpoint(scope),
    setTimeoutFn: () => 1,
    clearTimeoutFn: () => {}
  });
  coordinator.start({ meetingId, segmentId });
  return { persistence, coordinator, returned };
}

test('real adapter returns committed identity and coordinator confirms Cue coverage', async () => {
  const { persistence, coordinator, returned } = await createFixture();
  coordinator.enqueueCues([finalCue], cueCheckpoint);
  assert.equal(await coordinator.flush(), true);

  const readback = await persistence.getCheckpoint({ meetingId, segmentId });
  assert.equal(returned[0].meetingId, readback.meetingId);
  assert.equal(returned[0].segmentId, readback.segmentId);
  assert.deepEqual(returned[0].checkpoint, readback.checkpoint);
  assert.equal(readback.meetingId, meetingId);
  assert.equal(readback.segmentId, segmentId);
  assert.equal(readback.checkpoint.finalCues[0].cueId, finalCue.cueId);
  assert.equal(readback.checkpoint.cueCheckpoint.nextSequence, cueCheckpoint.nextSequence);
});

test('mismatched identity and insufficient Cue content cannot acknowledge a flush', async () => {
  for (const mutate of [
    (payload) => ({ ...payload, meetingId: 'other-meeting' }),
    (payload) => ({ ...payload, finalCues: [] })
  ]) {
    const persistence = createLocalMeetingPersistence({
      manifestStore: createInMemoryLocalMeetingManifestStore(),
      cryptoImpl: webcrypto, recordAudio: false, trace: () => {}
    });
    await persistence.saveCue({ meetingId, segmentId, sessionId: finalCue.sessionId, cue: finalCue });
    const coordinator = createMeetingCheckpointSyncCoordinator({
      updateCheckpoint: (payload) => persistence.updateCheckpoint(mutate(payload)),
      getCheckpoint: (scope) => persistence.getCheckpoint(scope),
      setTimeoutFn: () => 1,
      clearTimeoutFn: () => {}
    });
    coordinator.start({ meetingId, segmentId });
    coordinator.enqueueCues([finalCue], cueCheckpoint);
    assert.equal(await coordinator.flush(), false);
  }
});

test('failed storage and abnormal response after commit remain non-success', async () => {
  const backing = createInMemoryLocalMeetingManifestStore();
  const failedStore = {
    ...backing,
    async saveCheckpoint() { throw new Error('injected storage failure'); }
  };
  const failed = await createFixture(failedStore);
  failed.coordinator.enqueueCues([finalCue], cueCheckpoint);
  assert.equal(await failed.coordinator.flush(), false);
  assert.equal(await backing.getCheckpoint(meetingId, segmentId), null);

  const persistence = createLocalMeetingPersistence({
    manifestStore: createInMemoryLocalMeetingManifestStore(),
    cryptoImpl: webcrypto, recordAudio: false, trace: () => {}
  });
  await persistence.saveCue({ meetingId, segmentId, sessionId: finalCue.sessionId, cue: finalCue });
  const coordinator = createMeetingCheckpointSyncCoordinator({
    updateCheckpoint: async (payload) => {
      const committed = await persistence.updateCheckpoint(payload);
      return { checkpoint: committed.checkpoint };
    },
    getCheckpoint: (scope) => persistence.getCheckpoint(scope),
    setTimeoutFn: () => 1,
    clearTimeoutFn: () => {}
  });
  coordinator.start({ meetingId, segmentId });
  coordinator.enqueueCues([finalCue], cueCheckpoint);
  assert.equal(await coordinator.flush(), false);
  const readback = await persistence.getCheckpoint({ meetingId, segmentId });
  assert.equal(readback.checkpoint.finalCues[0].cueId, finalCue.cueId);
});

async function bundleBrowserModule(relativePath) {
  const bundle = await rolldown({
    input: fileURLToPath(new URL(relativePath, import.meta.url))
  });
  try {
    const { output } = await bundle.generate({ format: 'es' });
    assert.equal(output.length, 1);
    return `data:text/javascript;base64,${Buffer.from(output[0].code).toString('base64')}`;
  } finally {
    await bundle.close();
  }
}

test('isolated IndexedDB persists the real adapter flush across reload', async (t) => {
  const [adapterUrl, coordinatorUrl, storageUrl] = await Promise.all([
    bundleBrowserModule('../../src/lib/localMeetingPersistence.js'),
    bundleBrowserModule('../../src/lib/meetingCheckpointSyncCoordinator.js'),
    bundleBrowserModule('../../src/lib/localMeetingStorage.js')
  ]);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext();
  const origin = 'https://checkpoint-adapter.test/';
  await context.route('**/*', (route) => {
    if (route.request().url() === origin) {
      return route.fulfill({ body: '<!doctype html><title>Checkpoint contract</title>' });
    }
    return route.abort('blockedbyclient');
  });
  const page = await context.newPage();
  await page.goto(origin);
  const dbName = `checkpoint-contract-${Date.now()}-${Math.random()}`;
  const result = await page.evaluate(async ({ adapterUrl, coordinatorUrl, storageUrl, dbName, meetingId, segmentId, finalCue, cueCheckpoint }) => {
    const { createLocalMeetingPersistence } = await import(adapterUrl);
    const { createMeetingCheckpointSyncCoordinator } = await import(coordinatorUrl);
    const { createIndexedDbLocalMeetingManifestStore } = await import(storageUrl);
    const store = createIndexedDbLocalMeetingManifestStore({ indexedDBImpl: indexedDB, dbName });
    const persistence = createLocalMeetingPersistence({ manifestStore: store, recordAudio: false, trace: () => {} });
    await persistence.saveCue({ meetingId, segmentId, sessionId: finalCue.sessionId, cue: finalCue });
    let envelope = null;
    const coordinator = createMeetingCheckpointSyncCoordinator({
      updateCheckpoint: async (payload) => {
        envelope = await persistence.updateCheckpoint(payload);
        return envelope;
      },
      getCheckpoint: (scope) => persistence.getCheckpoint(scope),
      setTimeoutFn: () => 1,
      clearTimeoutFn: () => {}
    });
    coordinator.start({ meetingId, segmentId });
    coordinator.enqueueCues([finalCue], cueCheckpoint);
    return { flushed: await coordinator.flush(), envelope };
  }, { adapterUrl, coordinatorUrl, storageUrl, dbName, meetingId, segmentId, finalCue, cueCheckpoint });
  assert.equal(result.flushed, true);
  assert.equal(result.envelope.meetingId, meetingId);
  assert.equal(result.envelope.segmentId, segmentId);

  await page.reload();
  const readback = await page.evaluate(async ({ storageUrl, dbName, meetingId, segmentId }) => {
    const { createIndexedDbLocalMeetingManifestStore } = await import(storageUrl);
    const store = createIndexedDbLocalMeetingManifestStore({ indexedDBImpl: indexedDB, dbName });
    return store.getCheckpoint(meetingId, segmentId);
  }, { storageUrl, dbName, meetingId, segmentId });
  assert.equal(readback.meetingId, meetingId);
  assert.equal(readback.segmentId, segmentId);
  assert.equal(readback.checkpoint.finalCues[0].cueId, finalCue.cueId);
  assert.equal(readback.checkpoint.cueCheckpoint.nextSequence, cueCheckpoint.nextSequence);
  assert.deepEqual(result.envelope.checkpoint, readback.checkpoint);
  console.log('CHECKPOINT_INDEXEDDB_CONTRACT', JSON.stringify({
    flushed: result.flushed, meetingId: readback.meetingId,
    segmentId: readback.segmentId, finalCueIds: readback.checkpoint.finalCues.map((cue) => cue.cueId),
    nextSequence: readback.checkpoint.cueCheckpoint.nextSequence
  }));
});
