import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { rolldown } from 'rolldown';

test('B2 Pending survives reload, needs unique local segment proof, and leaves legacy data read only', async (t) => {
  const bundle = await rolldown({
    input: fileURLToPath(new URL('../../src/lib/localMeetingStorage.js', import.meta.url))
  });
  let source;
  try {
    const { output } = await bundle.generate({ format: 'es' });
    source = output[0].code;
  } finally { await bundle.close(); }
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('https://cue-b2-pending.test/', (route) => route.fulfill({ body: '<!doctype html>' }));
  await page.goto('https://cue-b2-pending.test/');
  const result = await page.evaluate(async (moduleUrl) => {
    const { createIndexedDbLocalMeetingManifestStore } = await import(moduleUrl);
    const dbName = `b2-pending-${Date.now()}`;
    const store = createIndexedDbLocalMeetingManifestStore({ dbName });
    await store.saveCheckpointFailure({ id: 'failure-1', meetingId: 'meeting-3',
      segmentId: 'old-segment', activeSegmentId: 'new-segment', historical: true,
      operation: 'RELOAD_PENDING_MUTATION_OWNERSHIP', rawStack: 'sensitive stack' });
    const cue = { cueId: 'pending-1', sessionId: 'session-1', liveSessionId: 'live-1',
      segmentId: null, sequence: 1, startTimeMs: 0, endTimeMs: 100,
      status: 'final', sourceText: 'hello', translatedText: 'world',
      sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en',
      sourceStatus: 'finalized', translationStatus: 'finalized' };
    const pending = await store.commitCueMutation({ meetingId: 'meeting-1', segmentId: null,
      eventKey: 'event-1', side: 'pending', cue });
    const cursorBefore = await store.getCheckpoint('meeting-1', 'segment-1');
    const sameEvent = await store.commitCueMutation({ meetingId: 'meeting-1', segmentId: null,
      eventKey: 'event-1', side: 'pending', cue });
    const freshStore = createIndexedDbLocalMeetingManifestStore({ dbName });
    const recoveredFailure = await freshStore.listCheckpointFailures('meeting-3');
    const recovered = await freshStore.listPendingCues('meeting-1');
    const ownerless = await freshStore.commitCueMutation({ meetingId: 'meeting-1',
      segmentId: 'segment-1', eventKey: 'event-2', side: 'initial',
      cue: { ...cue, segmentId: 'segment-1' } });
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    async function putSegment(segmentId) {
      await new Promise((resolve, reject) => {
        const tx = db.transaction('segments', 'readwrite');
        tx.objectStore('segments').put({ key: `meeting-1:${segmentId}`, meetingId: 'meeting-1',
          segmentId, recordingId: 'session-1', status: 'ACTIVE' });
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    }
    await putSegment('segment-1');
    const promoted = await freshStore.commitCueMutation({ meetingId: 'meeting-1',
      segmentId: 'segment-1', eventKey: 'event-3', side: 'initial',
      cue: { ...cue, segmentId: 'segment-1' } });
    const committed = await freshStore.listCues('meeting-1');
    const pendingAfter = await freshStore.listPendingCues('meeting-1');
    const cursorAfter = await freshStore.getCheckpoint('meeting-1', 'segment-1');
    const oldWrite = { ...cue, cueId: 'legacy-1', sessionId: 'old-session',
      segmentId: 'old-segment', revision: 1 };
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['cues', 'unassignedCues'], 'readwrite');
      tx.objectStore('cues').put({ key: ['meeting-legacy', 'old-segment', 'legacy-1'].join('\u0000'),
        meetingId: 'meeting-legacy', segmentId: 'old-segment', sessionId: 'old-session',
        cueId: 'legacy-1', sequence: 1, cue: oldWrite, updatedAt: Date.now() });
      tx.objectStore('unassignedCues').put({
        key: JSON.stringify(['meeting-legacy', 'old-session', 'legacy-unassigned']),
        meetingId: 'meeting-legacy', sessionId: 'old-session', cueId: 'legacy-unassigned',
        segmentId: null, sequence: 2, revision: 1, reason: 'missing_original_segment',
        cue: { ...cue, cueId: 'legacy-unassigned', sessionId: 'old-session',
          sequence: 2, revision: 1, segmentId: null }, updatedAt: Date.now()
      });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    const legacyMode = await freshStore.inspectCueAuthority('meeting-legacy');
    const legacyRejected = await freshStore.commitCueMutation({ meetingId: 'meeting-legacy',
      segmentId: null, eventKey: 'legacy-event', side: 'pending',
      cue: { ...cue, cueId: 'legacy-pending', sessionId: 'old-session' } });
    const legacyReadback = await freshStore.listCues('meeting-legacy');
    const legacyUnassigned = await freshStore.listUnassignedCues('meeting-legacy');
    const oldWriterBlocked = typeof freshStore.saveCue === 'undefined';

    const ambiguous = { ...cue, cueId: 'pending-ambiguous', sessionId: 'session-2',
      liveSessionId: 'live-2', sequence: 2 };
    await freshStore.commitCueMutation({ meetingId: 'meeting-2', segmentId: null,
      eventKey: 'ambiguous-1', side: 'pending', cue: ambiguous });
    await new Promise((resolve, reject) => {
      const tx = db.transaction('segments', 'readwrite');
      for (const segmentId of ['rollover-1', 'rollover-2']) {
        tx.objectStore('segments').put({ key: `meeting-2:${segmentId}`, meetingId: 'meeting-2',
          segmentId, recordingId: 'session-2', status: 'ACTIVE' });
      }
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    const rollover = await freshStore.commitCueMutation({ meetingId: 'meeting-2',
      segmentId: 'rollover-2', eventKey: 'ambiguous-2', side: 'initial',
      cue: { ...ambiguous, segmentId: 'rollover-2' } });
    const handoff = await freshStore.commitCueMutation({ meetingId: 'meeting-2',
      segmentId: 'rollover-1', eventKey: 'ambiguous-3', side: 'initial',
      cue: { ...ambiguous, segmentId: 'rollover-1', sessionId: 'session-3' } });
    const ambiguousCues = await freshStore.listCues('meeting-2');
    const ambiguousPending = await freshStore.listPendingCues('meeting-2');
    const ambiguousCursor = await freshStore.getCheckpoint('meeting-2', 'rollover-2');
    const ownedCue = { ...cue, cueId: 'owned-after-reload', sessionId: 'session-3',
      liveSessionId: 'live-old', sequence: 3 };
    await freshStore.commitCueMutation({ meetingId: 'meeting-3', segmentId: 'old-segment',
      eventKey: 'owned-pending', side: 'pending', cue: ownedCue });
    const reloadedStore = createIndexedDbLocalMeetingManifestStore({ dbName });
    await new Promise((resolve, reject) => {
      const tx = db.transaction('segments', 'readwrite');
      for (const segmentId of ['old-segment', 'new-segment']) {
        tx.objectStore('segments').put({ key: `meeting-3:${segmentId}`, meetingId: 'meeting-3',
          segmentId, recordingId: 'session-3', status: 'ENDED' });
      }
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    const wrongOwner = await reloadedStore.commitCueMutation({ meetingId: 'meeting-3',
      segmentId: 'new-segment', eventKey: 'wrong-owner', side: 'initial',
      cue: { ...ownedCue, segmentId: 'new-segment' } });
    const pendingAfterWrongOwner = await reloadedStore.listPendingCues('meeting-3');
    const rightOwner = await reloadedStore.commitCueMutation({ meetingId: 'meeting-3',
      segmentId: 'old-segment', eventKey: 'right-owner', side: 'initial',
      cue: { ...ownedCue, segmentId: 'old-segment' } });
    const ownedReadback = await reloadedStore.listCues('meeting-3');
    await freshStore.clearMeetingContent('meeting-2');
    const pendingAfterClear = await freshStore.listPendingCues('meeting-2');
    db.close();
    return { recoveredFailure, pendingStatus: pending.status, duplicateStatus: sameEvent.status,
      cursorBefore, recovered: recovered.length, pendingRevision: recovered[0]?.cue?.revision,
      ownerless: ownerless.reason, promoted: promoted.status,
      committed: committed.length, committedRevision: committed[0]?.cue?.revision,
      pendingAfter: pendingAfter.length, cursorAfter: cursorAfter?.checkpoint?.cueCursor,
      oldWrite: oldWrite.cueId, legacyMode, legacyRejected: legacyRejected.reason,
      legacyReadback: legacyReadback.length, legacyUnassigned: legacyUnassigned.length, oldWriterBlocked,
      rollover: rollover.reason, handoff: handoff.reason,
      ambiguousCues: ambiguousCues.length, ambiguousPending: ambiguousPending.length,
      ambiguousCursor, pendingAfterClear: pendingAfterClear.length,
      wrongOwner: wrongOwner.reason, rightOwner: rightOwner.status,
      pendingAfterWrongOwner: pendingAfterWrongOwner.length,
      ownedReadback: ownedReadback.map((row) => [row.segmentId, row.cueId]) };
  }, `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  assert.equal(result.pendingStatus, 'pending');
  assert.equal(result.recoveredFailure[0].operation, 'RELOAD_PENDING_MUTATION_OWNERSHIP');
  assert.equal(result.recoveredFailure[0].rawStack, undefined);
  assert.equal(result.recoveredFailure[0].historical, true);
  assert.equal(result.duplicateStatus, 'duplicate');
  assert.equal(result.cursorBefore, null);
  assert.equal(result.recovered, 1);
  assert.equal(result.pendingRevision, undefined);
  assert.equal(result.ownerless, 'cue_pending_ownership_unproven');
  assert.equal(result.promoted, 'committed');
  assert.equal(result.committed, 1);
  assert.equal(result.committedRevision, 1);
  assert.equal(result.pendingAfter, 0);
  assert.equal(result.cursorAfter.commitCount, 1);
  assert.equal(result.legacyMode, 'legacy_readonly');
  assert.equal(result.legacyRejected, 'cue_legacy_readonly');
  assert.equal(result.legacyReadback, 1);
    assert.equal(result.legacyUnassigned, 1);
  assert.equal(result.oldWriterBlocked, true);
  assert.equal(result.rollover, 'cue_pending_ownership_unproven');
  assert.equal(result.handoff, 'cue_pending_identity_conflict');
  assert.equal(result.ambiguousCues, 0);
  assert.equal(result.ambiguousPending, 1);
  assert.equal(result.ambiguousCursor, null);
  assert.equal(result.wrongOwner, 'cue_pending_ownership_unproven');
  assert.equal(result.pendingAfterWrongOwner, 1);
  assert.equal(result.rightOwner, 'committed');
  assert.deepEqual(result.ownedReadback, [['old-segment', 'owned-after-reload']]);
  assert.equal(result.pendingAfterClear, 0);
});
