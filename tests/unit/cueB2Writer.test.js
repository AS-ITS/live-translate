import assert from 'node:assert/strict';
import test from 'node:test';
import { createInMemoryLocalMeetingManifestStore } from '../../src/lib/localMeetingStorage.js';

const base = Object.freeze({
  cueId: 'cue:s1:g1:1', sessionId: 's1', segmentId: 'g1', sequence: 1,
  startTimeMs: 1, endTimeMs: 2, sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en',
  sourceText: 'hello', translatedText: 'world', sourceVersion: 1, translationVersion: 1,
  sourceStatus: 'finalized', translationStatus: 'finalized', status: 'final',
  finalizedReason: 'final', audioTurnId: 'turn-1', turnKey: 'turn-1',
  connectionEpoch: 1, providerEpoch: 1, providerEventSequence: 1
});

function mutation(eventKey, side, cue) {
  return { meetingId: 'm1', segmentId: 'g1', eventKey, side, cue };
}

test('B2 writer commits once and isolates one Cue conflict', async () => {
  const store = createInMemoryLocalMeetingManifestStore();
  const initial = mutation('e1', 'initial', base);
  assert.equal((await store.commitCueMutation(initial)).revision, 1);
  assert.equal((await store.commitCueMutation(initial)).status, 'duplicate');
  const translation = { ...base, translationVersion: 2, translatedText: 'world!',
    providerEventSequence: 2 };
  assert.equal((await store.commitCueMutation(mutation('e2', 'translation', translation))).revision, 2);
  const rejected = { ...base, sourceVersion: 2, sourceText: 'different',
    audioTurnId: 'other-turn', turnKey: 'other-turn', providerEventSequence: 3 };
  assert.equal((await store.commitCueMutation(mutation('e3', 'source', rejected))).status, 'rejected');
  const source = { ...base, sourceVersion: 2, sourceText: 'hello!', providerEventSequence: 4 };
  const accepted = await store.commitCueMutation(mutation('e4', 'source', source));
  assert.equal(accepted.revision, 3);
  assert.equal(accepted.cue.translatedText, 'world!');
  assert.equal((await store.listCueConflicts('m1')).length, 1);
});

test('B2 correction requires comparable turn and epoch evidence', async () => {
  const store = createInMemoryLocalMeetingManifestStore();
  await store.commitCueMutation(mutation('initial', 'initial', base));
  const correction = { ...base, sourceText: 'hi', sourceVersion: 2,
    providerEventSequence: 2 };
  assert.equal((await store.commitCueMutation(mutation('cross-epoch', 'source',
    { ...correction, providerEpoch: 2 }))).reason, 'cue_unproven_correction');
  assert.equal((await store.commitCueMutation(mutation('same-turn', 'source', correction))).status,
    'committed');
  assert.equal((await store.listCues('m1'))[0].cue.sourceText, 'hi');
});
