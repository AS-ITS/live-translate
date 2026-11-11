import assert from 'node:assert/strict';
import test from 'node:test';
import { createInMemoryLocalMeetingManifestStore } from '../../src/lib/localMeetingStorage.js';
import { mergeFinalCue } from '../../src/domain/subtitleCue/index.js';
import { createCueMutationCoordinator } from '../../src/lib/cueMutationCoordinator.js';

const base = Object.freeze({
  cueId: 'cue:s1:g1:1', sessionId: 's1', segmentId: 'g1', sequence: 1,
  startTimeMs: 1, endTimeMs: 2, sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en',
  sourceText: 'hello', translatedText: 'world', sourceVersion: 1, translationVersion: 1,
  sourceStatus: 'finalized', translationStatus: 'finalized', status: 'final',
  finalizedReason: 'final', audioTurnId: 'turn-1', turnKey: 'turn-1',
  connectionEpoch: 1, providerEpoch: 1, providerEventSequence: 1
});
const provenance = (eventSequence, providerEpoch = 1) => ({ audioTurnId: 'turn-1',
  turnKey: 'turn-1', connectionEpoch: 1, providerEpoch, eventSequence });

function mutation(eventKey, side, cue) {
  return { meetingId: 'm1', segmentId: 'g1', eventKey, side, cue };
}

test('B2 writer commits once and isolates one Cue conflict', async () => {
  const store = createInMemoryLocalMeetingManifestStore();
  const initial = mutation('e1', 'initial', base);
  assert.equal((await store.commitCueMutation(initial)).revision, 1);
  assert.equal((await store.commitCueMutation(initial)).status, 'duplicate');
  const translation = { ...base, translationVersion: 2, translatedText: 'world!',
    providerEventSequence: 2, translationProvenance: provenance(2) };
  assert.equal((await store.commitCueMutation(mutation('e2', 'translation', translation))).revision, 2);
  const rejected = { ...base, sourceVersion: 2, sourceText: 'different',
    audioTurnId: 'other-turn', turnKey: 'other-turn', providerEventSequence: 3 };
  assert.equal((await store.commitCueMutation(mutation('e3', 'source', rejected))).status, 'rejected');
  const source = { ...base, sourceVersion: 2, sourceText: 'hello!', providerEventSequence: 4,
    sourceProvenance: provenance(4) };
  const accepted = await store.commitCueMutation(mutation('e4', 'source', source));
  assert.equal(accepted.revision, 3);
  assert.equal(accepted.cue.translatedText, 'world!');
  assert.equal((await store.listCueConflicts('m1')).length, 1);
});

test('B2 correction requires comparable turn and epoch evidence', async () => {
  const store = createInMemoryLocalMeetingManifestStore();
  await store.commitCueMutation(mutation('initial', 'initial', base));
  const correction = { ...base, sourceText: 'hi', sourceVersion: 2,
    providerEventSequence: 2, sourceProvenance: provenance(2) };
  assert.equal((await store.commitCueMutation(mutation('cross-epoch', 'source',
    { ...correction, providerEpoch: 2, sourceProvenance: provenance(2, 2) }))).reason,
  'cue_source_event_unproven');
  assert.equal((await store.commitCueMutation(mutation('same-turn', 'source', correction))).status,
    'committed');
  assert.equal((await store.listCues('m1'))[0].cue.sourceText, 'hi');
});

test('Local Writer rejects changed authority text at the same side version', () => {
  for (const [field, version] of [['sourceText', 'sourceVersion'],
    ['translatedText', 'translationVersion']]) {
    assert.throws(() => mergeFinalCue([base], { ...base, [field]: `${base[field]} revised`,
      [version]: base[version], revision: 2 }), { code: 'subtitle_cue_conflict' });
  }
});

test('side allocator uses stored version and newer provider proof, not snapshot version', async () => {
  const store = createInMemoryLocalMeetingManifestStore();
  await store.commitCueMutation(mutation('initial', 'initial', base));
  const first = { ...base, sourceText: 'hello one', rawSource: 'hello one',
    sourceProvenance: provenance(2), providerEventSequence: 2 };
  const second = { ...base, sourceText: 'hello two', rawSource: 'hello two',
    sourceProvenance: provenance(3), providerEventSequence: 3 };
  const a = await store.commitCueMutation(mutation('source-2', 'source', first));
  const b = await store.commitCueMutation(mutation('source-3', 'source', second));
  assert.deepEqual([a.status, b.status], ['committed', 'committed']);
  assert.deepEqual([a.cue.sourceVersion, b.cue.sourceVersion], [2, 3]);
  assert.equal(b.cue.translationVersion, 1);
  assert.equal(b.cue.sourceProvenance.eventSequence, 3);
  assert.equal((await store.commitCueMutation(mutation('source-stale', 'source', first))).status,
    'rejected');
  assert.equal((await store.commitCueMutation(mutation('source-3-repeat', 'source', second))).status,
    'duplicate');
  assert.equal((await store.listCues('m1'))[0].cue.sourceText, 'hello two');
});

test('queued source and translation events commit in arrival order across both sides', async () => {
  const store = createInMemoryLocalMeetingManifestStore();
  let key = 0;
  const coordinator = createCueMutationCoordinator({
    commit: (job) => store.commitCueMutation(job), createEventKey: () => `queue-${++key}`
  });
  const source = (text, sequence) => ({ ...base, sourceText: text, rawSource: text,
    sourceProvenance: provenance(sequence), providerEventSequence: sequence });
  const translation = (text, sequence) => ({ ...base, translatedText: text,
    rawTranslation: text, initialTranslation: text,
    translationProvenance: provenance(sequence), providerEventSequence: sequence });
  await coordinator.enqueue({ meetingId: 'm1', segmentId: 'g1',
    changes: [{ before: null, cue: base }] });
  const events = [
    { side: 'source', cue: source('hello one', 2) },
    { side: 'translation', cue: translation('world one', 3) },
    { side: 'source', cue: source('hello two', 4) },
    { side: 'translation', cue: translation('world two', 5) }
  ];
  const results = await Promise.all(events.map((event) => coordinator.enqueue({
    meetingId: 'm1', segmentId: 'g1', changes: [{ before: base, cue: event.cue }]
  })));
  assert.deepEqual(results.flat().map(({ result }) => result.status),
    ['committed', 'committed', 'committed', 'committed']);
  assert.deepEqual(await coordinator.flush(), []);
  const saved = (await store.listCues('m1'))[0].cue;
  assert.deepEqual([saved.sourceText, saved.sourceVersion, saved.sourceProvenance.eventSequence],
    ['hello two', 3, 4]);
  assert.deepEqual([saved.translatedText, saved.translationVersion,
    saved.translationProvenance.eventSequence], ['world two', 3, 5]);
});
