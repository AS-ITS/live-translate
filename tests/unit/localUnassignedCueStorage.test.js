import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chromium } from '@playwright/test';
import { rolldown } from 'rolldown';
import {
  createInMemoryLocalMeetingManifestStore,
  createIndexedDbLocalMeetingManifestStore
} from '../../src/lib/localMeetingStorage.js';
import { createLocalMeetingPersistence } from '../../src/lib/localMeetingPersistence.js';

const input = {
  meetingId: 'meeting-1', sessionId: 'session-1', cueId: 'cue-1', sequence: 1,
  revision: 1, reason: 'missing_original_segment',
  sourceIdentity: { liveSessionId: 'live-1', eventId: 'event-1' },
  cue: {
    cueId: 'cue-1', sessionId: 'session-1', segmentId: null, sequence: 1,
    status: 'partial', startTimeMs: 100, endTimeMs: 150,
    sourceText: 'hello', translatedText: '', ephemeralToken: 'secret'
  }
};

async function browserModule() {
  const bundle = await rolldown({
    input: fileURLToPath(new URL('../../src/lib/localMeetingStorage.js', import.meta.url))
  });
  try {
    const { output } = await bundle.generate({ format: 'es' });
    return `data:text/javascript;base64,${Buffer.from(output[0].code).toString('base64')}`;
  } finally {
    await bundle.close();
  }
}

async function isolatedPage(t, origin) {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route(`${origin}/`, (route) => route.fulfill({ body: '<!doctype html>' }));
  await page.goto(`${origin}/`);
  return page;
}

test('unassigned Cue writes are idempotent, revisioned and preserve immutable identity', async () => {
  const store = createInMemoryLocalMeetingManifestStore();
  const first = await store.saveUnassignedCue(input);
  assert.equal(first.segmentId, null);
  assert.equal(first.cue.ephemeralToken, undefined);
  assert.deepEqual(await store.saveUnassignedCue(input), first);
  const final = await store.saveUnassignedCue({
    ...input, revision: 2,
    cue: { ...input.cue, status: 'final', endTimeMs: 170, sourceText: 'hello world' }
  });
  assert.equal(final.revision, 2);
  assert.equal((await store.listUnassignedCues(input.meetingId))[0].cue.sourceText, 'hello world');
  await assert.rejects(store.saveUnassignedCue({
    ...input, sequence: 2, cue: { ...input.cue, sequence: 2 }
  }), { code: 'local_unassigned_cue_identity_conflict' });
  await assert.rejects(store.saveUnassignedCue({ ...input, sourceIdentity: { eventId: 'other' } }), { code: 'local_unassigned_cue_identity_conflict' });
  await assert.rejects(store.saveUnassignedCue(input), { code: 'local_unassigned_cue_stale_revision' });
  await assert.rejects(store.saveUnassignedCue({
    ...input, revision: 3, cue: { ...input.cue, status: 'partial', sourceText: 'regression' }
  }), { code: 'local_unassigned_cue_revision_conflict' });
  assert.deepEqual((await store.getUnassignedCue(input.meetingId, input.sessionId, input.cueId)), final);
  assert.equal(await store.countUnassignedCues(input.meetingId), 1);
  await assert.rejects(store.saveUnassignedCue({ ...input, cueId: '' }), { code: 'invalid_request' });
  await assert.rejects(store.saveUnassignedCue({ ...input, cueId: 'cue-2', cue: { ...input.cue, cueId: 'cue-2', segmentId: 's3' } }), { code: 'invalid_request' });
  const firstScope = await store.saveUnassignedCue({ ...input, meetingId: 'a\u0000b', sessionId: 'c', cue: { ...input.cue, sessionId: 'c' } });
  const secondScope = await store.saveUnassignedCue({ ...input, meetingId: 'a', sessionId: 'b\u0000c', cue: { ...input.cue, sessionId: 'b\u0000c' } });
  assert.notEqual(firstScope.key, secondScope.key);
});

test('persistence adapter exposes a failed unassigned write to its caller', async () => {
  const expected = Object.assign(new Error('quota exceeded'), { name: 'QuotaExceededError' });
  const manifestStore = createInMemoryLocalMeetingManifestStore();
  const persistence = createLocalMeetingPersistence({
    manifestStore: { ...manifestStore, async saveUnassignedCue() { throw expected; } },
    cryptoImpl: webcrypto, recordAudio: false, trace: () => {}
  });
  await assert.rejects(persistence.saveUnassignedCue(input), (error) => error === expected);
});

test('v5 IndexedDB Cue remains unchanged while v6 unassigned Cue survives reload', async (t) => {
  const page = await isolatedPage(t, 'https://unassigned-migration.test');
  const moduleUrl = await browserModule();
  const result = await page.evaluate(async ({ moduleUrl, input }) => {
    const dbName = `unassigned-migration-${crypto.randomUUID()}`;
    const legacy = {
      schemaVersion: 5, key: 'meeting-1\u0000s2\u0000old-cue', meetingId: 'meeting-1',
      sessionId: 'session-1', segmentId: 's2', cueId: 'old-cue', sequence: 1,
      cue: { cueId: 'old-cue', segmentId: 's2', sequence: 1, sourceText: 'legacy' },
      producedAt: 100, updatedAt: 100
    };
    await new Promise((resolve, reject) => {
      const open = indexedDB.open(dbName, 5);
      open.onupgradeneeded = () => {
        const cues = open.result.createObjectStore('cues', { keyPath: 'key' });
        cues.createIndex('meeting-segment-sequence', ['meetingId', 'segmentId', 'sequence'], { unique: true });
      };
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const database = open.result;
        const transaction = database.transaction('cues', 'readwrite');
        transaction.objectStore('cues').put(legacy);
        transaction.oncomplete = () => { database.close(); resolve(); };
        transaction.onerror = () => reject(transaction.error);
      };
    });
    const { createIndexedDbLocalMeetingManifestStore } = await import(moduleUrl);
    const store = createIndexedDbLocalMeetingManifestStore({ indexedDBImpl: indexedDB, dbName });
    await store.saveUnassignedCue(input);
    const repeated = await store.saveUnassignedCue(input);
    const conflict = await store.saveUnassignedCue({
      ...input, sequence: 2, cue: { ...input.cue, sequence: 2 }
    }).then(() => null, (error) => error.code);
    await store.saveUnassignedCue({ ...input, meetingId: 'unassigned-only' });
    const database = await new Promise((resolve, reject) => {
      const open = indexedDB.open(dbName, 6);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const version = database.version;
    const rawLegacy = await new Promise((resolve, reject) => {
      const request = database.transaction('cues').objectStore('cues').get(legacy.key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return { dbName, version, rawLegacy, legacy, repeated, conflict };
  }, { moduleUrl, input });
  assert.equal(result.version, 6);
  assert.deepEqual(result.rawLegacy, result.legacy);
  assert.equal(result.repeated.revision, 1);
  assert.equal(result.conflict, 'local_unassigned_cue_identity_conflict');
  await page.reload();
  const restored = await page.evaluate(async ({ moduleUrl, dbName, input }) => {
    const { createIndexedDbLocalMeetingManifestStore } = await import(moduleUrl);
    const store = createIndexedDbLocalMeetingManifestStore({ indexedDBImpl: indexedDB, dbName });
    return {
      unassigned: await store.getUnassignedCue(input.meetingId, input.sessionId, input.cueId),
      count: await store.countUnassignedCues(input.meetingId),
      meetingIds: (await store.listLocalMeetingIds()).sort(),
      assigned: await store.listCues(input.meetingId),
      cleanupError: await store.clearMeetingContent(input.meetingId).then(() => null, (error) => error.code),
      afterCleanup: await store.countUnassignedCues(input.meetingId),
      assignedAfterCleanup: (await store.listCues(input.meetingId)).length
    };
  }, { moduleUrl, dbName: result.dbName, input });
  assert.equal(restored.unassigned.cue.sourceText, 'hello');
  assert.equal(restored.unassigned.cue.ephemeralToken, undefined);
  assert.equal(restored.count, 1);
  assert.deepEqual(restored.meetingIds, ['meeting-1', 'unassigned-only']);
  assert.equal(restored.assigned[0].cue.sourceText, 'legacy');
  assert.equal(restored.cleanupError, 'local_unassigned_cues_pending');
  assert.equal(restored.afterCleanup, 1);
  assert.equal(restored.assignedAfterCleanup, 1);
});

test('blocked v5 to v6 upgrade and failed open are reported', async (t) => {
  const page = await isolatedPage(t, 'https://unassigned-blocked.test');
  const moduleUrl = await browserModule();
  const result = await page.evaluate(async ({ moduleUrl, input }) => {
    const dbName = `unassigned-blocked-${crypto.randomUUID()}`;
    const legacy = await new Promise((resolve, reject) => {
      const open = indexedDB.open(dbName, 5);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    legacy.onversionchange = () => {};
    const { createIndexedDbLocalMeetingManifestStore } = await import(moduleUrl);
    const store = createIndexedDbLocalMeetingManifestStore({ indexedDBImpl: indexedDB, dbName });
    const blocked = await store.saveUnassignedCue(input).then(() => null, (error) => error.message);
    legacy.close();
    const failedStore = createIndexedDbLocalMeetingManifestStore({
      indexedDBImpl: { open() { throw new Error('disk unavailable'); } }, dbName: 'failed'
    });
    const failed = await failedStore.saveUnassignedCue(input).then(() => null, (error) => error.message);
    return { blocked, failed };
  }, { moduleUrl, input });
  assert.match(result.blocked, /blocked/i);
  assert.match(result.failed, /disk unavailable/);
});

test('v6 IndexedDB assigned Cue CAS rejects stale writes and preserves concurrent highest revision', async (t) => {
  const page = await isolatedPage(t, 'https://cue-revision.test');
  const moduleUrl = await browserModule();
  const dbName = `cue-revision-${webcrypto.randomUUID()}`;
  const result = await page.evaluate(async ({ moduleUrl, dbName }) => {
    const { createIndexedDbLocalMeetingManifestStore } = await import(moduleUrl);
    const store = createIndexedDbLocalMeetingManifestStore({ indexedDBImpl: indexedDB, dbName });
    const assigned = (revision, sourceText, sequence = 1) => ({
      meetingId: 'm', sessionId: 's', segmentId: 'seg',
      cue: { cueId: `cue:s:seg:${sequence}`, sessionId: 's', segmentId: 'seg', sequence,
        status: 'final', startTimeMs: 0, endTimeMs: 1, sourceText, translatedText: '',
        ...(revision == null ? {} : { revision }) }
    });
    await store.saveCue(assigned(null, 'legacy'));
    await store.saveCue(assigned(1, 'first'));
    await store.saveCue(assigned(3, 'newest'));
    const stale = await store.saveCue(assigned(2, 'older')).then(() => null, (error) => error.code);
    const deterministicStored = (await store.listCues('m')).find((record) => record.cueId === 'cue:s:seg:1').cue;
    const same = await store.saveCue(assigned(3, 'newest'));
    const conflict = await store.saveCue(assigned(3, 'different')).then(() => null, (error) => error.code);
    const legacyOverwrite = await store.saveCue(assigned(null, 'legacy')).then(() => null, (error) => error.code);

    const writes = await Promise.allSettled([
      store.saveCue(assigned(2, 'older', 2)),
      store.saveCue(assigned(3, 'newest', 2))
    ]);
    const concurrentStored = (await store.listCues('m')).find((record) => record.cueId === 'cue:s:seg:2').cue;
    return {
      stale, deterministicStored, sameRevision: same.cue.revision, conflict, legacyOverwrite,
      writes: writes.map((item) => item.status === 'rejected' ? item.reason.code : 'saved'),
      concurrentStored
    };
  }, { moduleUrl, dbName });
  assert.equal(result.stale, 'local_cue_stale_revision');
  assert.equal(result.deterministicStored.revision, 3);
  assert.equal(result.deterministicStored.sourceText, 'newest');
  assert.equal(result.sameRevision, 3);
  assert.equal(result.conflict, 'local_cue_revision_conflict');
  assert.equal(result.legacyOverwrite, 'local_cue_stale_revision');
  assert.ok([
    ['saved', 'saved'],
    ['local_cue_stale_revision', 'saved']
  ].some((outcome) => outcome.every((value, index) => value === result.writes[index])));
  assert.equal(result.concurrentStored.revision, 3);
  assert.equal(result.concurrentStored.sourceText, 'newest');
  await page.reload();
  const restored = await page.evaluate(async ({ moduleUrl, dbName }) => {
    const { createIndexedDbLocalMeetingManifestStore } = await import(moduleUrl);
    const store = createIndexedDbLocalMeetingManifestStore({ indexedDBImpl: indexedDB, dbName });
    return (await store.listCues('m')).map((record) => record.cue);
  }, { moduleUrl, dbName });
  assert.deepEqual(restored.map(({ revision, sourceText }) => ({ revision, sourceText })), [
    { revision: 3, sourceText: 'newest' },
    { revision: 3, sourceText: 'newest' }
  ]);
});

test('v6 IndexedDB provisional Cue survives reload and merge reconciliation is atomic', async (t) => {
  const page = await isolatedPage(t, 'https://provisional-cue.test');
  const moduleUrl = await browserModule();
  const dbName = `provisional-cue-${webcrypto.randomUUID()}`;
  const result = await page.evaluate(async ({ moduleUrl, dbName }) => {
    const { createIndexedDbLocalMeetingManifestStore } = await import(moduleUrl);
    const store = createIndexedDbLocalMeetingManifestStore({ indexedDBImpl: indexedDB, dbName });
    const cue = (cueId, sequence, revision, status, sourceText) => ({
      cueId, sessionId: 's', segmentId: null, sequence, revision, status,
      sourceText, translatedText: '', startTimeMs: sequence * 100, endTimeMs: sequence * 100 + 10
    });
    const record = (value) => ({ meetingId: 'm', sessionId: 's', cueId: value.cueId,
      sequence: value.sequence, revision: value.revision,
      reason: 'missing_original_segment', cue: value });
    const first = cue('cue:s:1', 1, 1, 'partial', 'hello');
    await store.reconcileUnassignedCues({ upserts: [record(first)] });
    const partial = await store.getUnassignedCue('m', 's', first.cueId);
    const final = cue(first.cueId, 1, 2, 'final', 'hello');
    await store.reconcileUnassignedCues({ upserts: [record(final)] });
    const loser = cue('cue:s:2', 2, 1, 'partial', ' world');
    await store.reconcileUnassignedCues({ upserts: [record(loser)] });
    const merged = cue(first.cueId, 1, 3, 'final', 'hello world');
    const removal = { meetingId: 'm', sessionId: 's', cueId: loser.cueId,
      revision: loser.revision, survivorCueId: first.cueId };
    const failed = await store.reconcileUnassignedCues({
      upserts: [record(merged)], removals: [{ ...removal, revision: 2 }]
    }).then(() => null, (error) => error.code);
    const afterFailure = await store.listUnassignedCues('m');
    await store.reconcileUnassignedCues({ upserts: [record(merged)], removals: [removal] });
    const stale = await store.saveUnassignedCue(record(final)).then(() => null, (error) => error.code);
    const missingIdentity = await store.saveUnassignedCue({ ...record(loser), cueId: '' })
      .then(() => null, (error) => error.code || error.message);
    return { partial, failed, afterFailure, stale, missingIdentity };
  }, { moduleUrl, dbName });
  assert.equal(result.partial.cue.status, 'partial');
  assert.equal(result.partial.cue.segmentId, null);
  assert.equal(result.partial.cue.revision, 1);
  assert.equal(result.failed, 'local_unassigned_cue_stale_revision');
  assert.equal(result.afterFailure.length, 2);
  assert.equal(result.afterFailure.find((item) => item.cueId === 'cue:s:1').revision, 2);
  assert.equal(result.stale, 'local_unassigned_cue_stale_revision');
  assert.ok(result.missingIdentity);
  await page.reload();
  const restored = await page.evaluate(async ({ moduleUrl, dbName }) => {
    const { createIndexedDbLocalMeetingManifestStore } = await import(moduleUrl);
    const store = createIndexedDbLocalMeetingManifestStore({ indexedDBImpl: indexedDB, dbName });
    return store.listUnassignedCues('m');
  }, { moduleUrl, dbName });
  assert.deepEqual(restored.map((item) => item.cueId), ['cue:s:1']);
  assert.equal(restored[0].revision, 3);
  assert.equal(restored[0].allocationFloor, 3);
  assert.equal(restored[0].cue.sourceText, 'hello world');
  assert.equal(restored[0].cue.segmentId, null);
  await page.evaluate(async ({ moduleUrl, dbName }) => {
    const { createIndexedDbLocalMeetingManifestStore } = await import(moduleUrl);
    const store = createIndexedDbLocalMeetingManifestStore({ indexedDBImpl: indexedDB, dbName });
    const record = (await store.listUnassignedCues('m'))[0];
    await store.saveUnassignedCue({ ...record, revision: 4,
      cue: { ...record.cue, revision: 4, dismissed: true } });
  }, { moduleUrl, dbName });
  await page.reload();
  const retired = await page.evaluate(async ({ moduleUrl, dbName }) => {
    const { createIndexedDbLocalMeetingManifestStore } = await import(moduleUrl);
    const store = createIndexedDbLocalMeetingManifestStore({ indexedDBImpl: indexedDB, dbName });
    return store.listUnassignedCues('m');
  }, { moduleUrl, dbName });
  assert.equal(retired[0].revision, 4);
  assert.equal(retired[0].cue.dismissed, true);
  assert.equal(retired[0].allocationFloor, 3);
});
