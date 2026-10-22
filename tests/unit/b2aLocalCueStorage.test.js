import assert from 'node:assert/strict';
import test from 'node:test';
import { createInMemoryLocalMeetingManifestStore } from '../../src/lib/localMeetingStorage.js';

const assigned = (revision, sourceText = 'hello') => ({
  meetingId: 'meeting-1', segmentId: 'segment-1', sessionId: 'session-1',
  cue: {
    cueId: 'cue:session-1:segment-1:1', sessionId: 'session-1', segmentId: 'segment-1',
    sequence: 1, status: 'final', startTimeMs: 1, endTimeMs: 2,
    sourceText, translatedText: '', ...(revision == null ? {} : { revision })
  }
});

const unassigned = (wrapperRevision, cueRevision = wrapperRevision) => ({
  meetingId: 'meeting-1', sessionId: 'session-1',
  cueId: 'cue:session-1:2', sequence: 2, revision: wrapperRevision,
  reason: 'missing_original_segment',
  cue: {
    cueId: 'cue:session-1:2', sessionId: 'session-1', segmentId: null,
    sequence: 2, status: 'partial', startTimeMs: 3, endTimeMs: 4,
    sourceText: 'world', translatedText: '', revision: cueRevision
  }
});

test('assigned Cue storage rejects stale/conflicting revisions and accepts identical retry', async () => {
  const store = createInMemoryLocalMeetingManifestStore();
  const first = await store.saveCue(assigned(2));
  assert.equal((await store.saveCue(assigned(2))).cue.revision, first.cue.revision);
  await assert.rejects(store.saveCue(assigned(1)), { code: 'local_cue_stale_revision' });
  await assert.rejects(store.saveCue(assigned(2, 'different')), { code: 'local_cue_revision_conflict' });
  assert.equal((await store.listCues('meeting-1'))[0].cue.sourceText, 'hello');
});

test('assigned Cue storage serializes out-of-order writes and preserves legacy revision zero', async () => {
  const store = createInMemoryLocalMeetingManifestStore();
  await store.saveCue(assigned(null, 'legacy'));
  await store.saveCue(assigned(1, 'updated'));
  await assert.rejects(store.saveCue(assigned(null, 'legacy')), { code: 'local_cue_stale_revision' });
  const writes = await Promise.allSettled([store.saveCue(assigned(3, 'newest')), store.saveCue(assigned(2, 'older'))]);
  assert.equal(writes[0].status, 'fulfilled');
  assert.equal(writes[1].status, 'rejected');
  assert.equal((await store.listCues('meeting-1'))[0].cue.revision, 3);
});

test('unassigned Cue storage rejects wrapper/Cue revision mismatch', async () => {
  const store = createInMemoryLocalMeetingManifestStore();
  await assert.rejects(store.saveUnassignedCue(unassigned(2, 1)), { code: 'invalid_request' });
  const saved = await store.saveUnassignedCue(unassigned(1));
  assert.equal(saved.cue.revision, saved.revision);
});

test('unassigned Cue timing change is accepted with a higher revision', async () => {
  const store = createInMemoryLocalMeetingManifestStore();
  await store.saveUnassignedCue(unassigned(1));
  const changed = unassigned(2);
  changed.cue.startTimeMs = 2;
  const saved = await store.saveUnassignedCue(changed);
  assert.equal(saved.cue.startTimeMs, 2);
  assert.equal(saved.revision, 2);
});

test('unassigned reconciliation applies survivor update and loser removal atomically', async () => {
  const store = createInMemoryLocalMeetingManifestStore();
  const survivor = unassigned(1);
  const loser = { ...unassigned(1), cueId: 'cue:session-1:3', sequence: 3,
    cue: { ...unassigned(1).cue, cueId: 'cue:session-1:3', sequence: 3 } };
  await store.saveUnassignedCue(survivor);
  await store.saveUnassignedCue(loser);
  const updated = { ...unassigned(2), cue: { ...unassigned(2).cue, sourceText: 'joined' } };
  const removal = { meetingId: survivor.meetingId, sessionId: survivor.sessionId,
    cueId: loser.cueId, revision: 1, survivorCueId: survivor.cueId };

  await assert.rejects(store.reconcileUnassignedCues({
    upserts: [updated], removals: [{ ...removal, revision: 2 }]
  }), { code: 'local_unassigned_cue_stale_revision' });
  assert.equal((await store.getUnassignedCue(survivor.meetingId, survivor.sessionId, survivor.cueId)).revision, 1);
  assert.ok(await store.getUnassignedCue(loser.meetingId, loser.sessionId, loser.cueId));

  await store.reconcileUnassignedCues({ upserts: [updated], removals: [removal] });
  const saved = await store.getUnassignedCue(survivor.meetingId, survivor.sessionId, survivor.cueId);
  assert.equal(saved.revision, 2);
  assert.equal(saved.cue.sourceText, 'joined');
  assert.ok(saved.allocationFloor >= 4);
  assert.equal(await store.getUnassignedCue(loser.meetingId, loser.sessionId, loser.cueId), null);
});
