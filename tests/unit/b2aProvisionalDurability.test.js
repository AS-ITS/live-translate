import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test from 'node:test';
import { createInMemoryLocalMeetingManifestStore } from '../../src/lib/localMeetingStorage.js';
import { createLocalMeetingPersistence } from '../../src/lib/localMeetingPersistence.js';
import {
  applySubtitleCueEvent, commitSubtitleCueState, createSubtitleCueState,
  dismissSubtitleCue, finalizePendingSubtitleCue, nextCueSequenceFromRecords, unassignedCuePersistenceChanges
} from '../../src/lib/subtitleCues.js';

const meetingId = 'meeting-1';
const sessionId = 'session-1';

function accept(previous, event) {
  const result = commitSubtitleCueState(previous, applySubtitleCueEvent(previous, event));
  assert.equal(result.accepted, true);
  return result.state;
}

function source(eventId, text, sessionTimeMs, isFinal = false) {
  return { eventId, sessionId, segmentId: null, turnKey: 'turn-1', stream: 'source',
    text, sessionTimeMs, isFinal, sourceLanguageCode: 'en', targetLanguageCode: 'fr' };
}

function record(cue) {
  return { meetingId, sessionId, cueId: cue.cueId, sequence: cue.sequence,
    revision: cue.revision, reason: 'missing_original_segment', cue };
}

test('visible unknown-owner partial is selected for durability and keeps identity through update', async () => {
  const store = createInMemoryLocalMeetingManifestStore();
  let previous = createSubtitleCueState();
  let next = accept(previous, source('s1', 'hel', 100));
  const first = unassignedCuePersistenceChanges(previous, next);
  assert.equal(first.upserts.length, 1);
  assert.equal(first.upserts[0].segmentId, null);
  assert.equal(first.upserts[0].status, 'partial');
  assert.equal(first.upserts[0].revision, 1);
  await store.reconcileUnassignedCues({ upserts: first.upserts.map(record), removals: [] });
  const cueId = next.currentCue.cueId;
  previous = next;
  next = accept(previous, source('s2', 'hello', 120, true));
  const second = unassignedCuePersistenceChanges(previous, next);
  await store.reconcileUnassignedCues({ upserts: second.upserts.map(record), removals: [] });
  const recovered = await store.getUnassignedCue(meetingId, sessionId, cueId);
  assert.equal(recovered.cue.cueId, cueId);
  assert.equal(recovered.cue.segmentId, null);
  assert.equal(recovered.cue.revision, 2);
});

test('intentional dismissal durably retires a provisional Cue without reusing its identity', async () => {
  const store = createInMemoryLocalMeetingManifestStore();
  const initial = createSubtitleCueState();
  const visible = accept(initial, source('s1', 'hello', 100));
  await store.reconcileUnassignedCues({
    upserts: unassignedCuePersistenceChanges(initial, visible).upserts.map(record)
  });
  const retired = commitSubtitleCueState(visible,
    dismissSubtitleCue(visible, visible.currentCue.cueId)).state;
  assert.equal(retired.currentCue, null);
  const changes = unassignedCuePersistenceChanges(visible, retired);
  assert.equal(changes.upserts.length, 1);
  assert.equal(changes.upserts[0].cueId, visible.currentCue.cueId);
  assert.equal(changes.upserts[0].revision, 2);
  assert.equal(changes.upserts[0].dismissed, true);
  await store.reconcileUnassignedCues({ upserts: changes.upserts.map(record) });
  const records = await store.listUnassignedCues(meetingId);
  assert.equal(records[0].cue.dismissed, true);
  assert.equal(nextCueSequenceFromRecords(1, records), 2);
});

test('atomic survivor update removes persisted provisional loser', async () => {
  const store = createInMemoryLocalMeetingManifestStore();
  const survivor = { cueId: 'cue:session-1:1', sessionId, segmentId: null, sequence: 1,
    revision: 2, status: 'final', sourceText: 'hello', translatedText: 'bonjour',
    startTimeMs: 0, endTimeMs: 100 };
  const loser = { ...survivor, cueId: 'cue:session-1:2', sequence: 2,
    revision: 1, status: 'partial', sourceText: ' world', translatedText: '',
    startTimeMs: 110, endTimeMs: 140 };
  await store.saveUnassignedCue(record(survivor));
  await store.saveUnassignedCue(record(loser));
  const previous = createSubtitleCueState({ finalCues: [survivor], currentCue: loser, nextSequence: 3 });
  const next = {
    ...createSubtitleCueState({ finalCues: [{ ...survivor, sourceText: 'hello world', revision: 3 }], nextSequence: 3 }),
    mergedCueIds: [{ loserCueId: loser.cueId, survivorCueId: survivor.cueId }],
  };
  const changes = unassignedCuePersistenceChanges(previous, next);
  assert.deepEqual(changes.removals.map((cue) => cue.cueId), [loser.cueId]);
  await store.reconcileUnassignedCues({
    upserts: changes.upserts.map(record),
    removals: changes.removals.map((cue) => ({ meetingId, sessionId, cueId: cue.cueId,
      revision: cue.revision, survivorCueId: survivor.cueId }))
  });
  assert.deepEqual((await store.listUnassignedCues(meetingId)).map((item) => item.cueId), [survivor.cueId]);
  assert.equal((await store.getUnassignedCue(meetingId, sessionId, loser.cueId)), null);
  assert.equal(nextCueSequenceFromRecords(1, await store.listUnassignedCues(meetingId)), 3);
});

test('unassigned reconciliation failure reaches the persistence caller', async () => {
  const failure = Object.assign(new Error('disk unavailable'), { name: 'QuotaExceededError' });
  const manifestStore = createInMemoryLocalMeetingManifestStore();
  const persistence = createLocalMeetingPersistence({
    manifestStore: { ...manifestStore, async reconcileUnassignedCues() { throw failure; } },
    cryptoImpl: webcrypto, recordAudio: false, trace: () => {}
  });
  const cue = { cueId: 'cue:session-1:1', sessionId, segmentId: null, sequence: 1,
    revision: 1, status: 'partial', sourceText: 'hello', translatedText: '',
    startTimeMs: 0, endTimeMs: 10 };
  await assert.rejects(persistence.reconcileUnassignedCues({ upserts: [record(cue)] }),
    (error) => error === failure);
});

test('two persisted provisional Cues merged in one finalization remove the loser', () => {
  const first = { cueId: 'cue:session-1:1', sessionId, segmentId: null,
    sequence: 1, revision: 1, status: 'partial',
    sourceText: 'Actually,', translatedText: 'En fait,',
    sourceStatus: 'finalized', translationStatus: 'finalized',
    sourceVersion: 1, translationVersion: 1,
    sourceLanguageCode: 'en', targetLanguageCode: 'fr',
    startTimeMs: 100, endTimeMs: 120 };
  const second = { ...first, cueId: 'cue:session-1:2', sequence: 2,
    sourceText: 'it works', translatedText: 'ça marche',
    startTimeMs: 200, endTimeMs: 220 };
  const previous = createSubtitleCueState({ pendingCues: [first, second], nextSequence: 3 });
  const next = commitSubtitleCueState(previous,
    finalizePendingSubtitleCue(previous, { sessionTimeMs: 240, reason: 'test' })).state;
  assert.equal(next.finalCues.length, 1);
  const changes = unassignedCuePersistenceChanges(previous, next);
  assert.deepEqual(changes.removals.map((cue) => cue.cueId), [second.cueId]);
  assert.equal(changes.removals[0].survivorCueId, first.cueId);
});
