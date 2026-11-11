import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applySubtitleCueEvent, commitSubtitleCueState, createSubtitleCueState,
  durableUnassignedFinalCues,
  unassignedCuePersistenceChanges,
  finalizePendingSubtitleCue
} from '../../src/lib/subtitleCues.js';

const event = (eventId, stream, text, sessionTimeMs, isFinal = false) => ({
  eventId, sessionId: 'session-1', segmentId: 'segment-1', turnKey: 'turn-1',
  stream, text, sessionTimeMs, isFinal, sourceLanguageCode: 'en', targetLanguageCode: 'fr'
});

function accept(state, proposed) {
  const result = commitSubtitleCueState(state, proposed);
  assert.equal(result.accepted, true);
  return result.state;
}

test('partial, source, translation and finalization preserve Cue ID and advance revision', () => {
  let state = createSubtitleCueState();
  state = accept(state, applySubtitleCueEvent(state, event('s1', 'source', 'hel', 100)));
  const cueId = state.currentCue.cueId;
  assert.equal(state.currentCue.revision, 1);
  state = accept(state, applySubtitleCueEvent(state, event('s2', 'source', 'hello', 120)));
  assert.equal(state.currentCue.revision, 2);
  state = accept(state, applySubtitleCueEvent(state, event('t1', 'translation', 'bonjour', 130)));
  assert.equal(state.currentCue.revision, 3);
  state = accept(state, applySubtitleCueEvent(state, event('s3', 'source', 'hello', 140, true)));
  state = accept(state, applySubtitleCueEvent(state, event('t2', 'translation', 'bonjour', 150, true)));
  state = accept(state, finalizePendingSubtitleCue(state, { sessionTimeMs: 160, reason: 'test' }));
  assert.equal(state.finalCues[0].cueId, cueId);
  assert.equal(state.finalCues[0].status, 'final');
  assert.ok(state.finalCues[0].revision > 3);
});

test('no-op state and duplicate Provider event do not advance revision', () => {
  let state = createSubtitleCueState();
  const first = event('s1', 'source', 'hello', 100);
  state = accept(state, applySubtitleCueEvent(state, first));
  const revision = state.currentCue.revision;
  state = accept(state, applySubtitleCueEvent(state, first));
  assert.equal(state.currentCue.revision, revision);
  state = accept(state, { ...state, currentCue: { ...state.currentCue } });
  assert.equal(state.currentCue.revision, revision);
});

test('refinement snapshot increments and stale async proposal is rejected', () => {
  let state = createSubtitleCueState();
  state = accept(state, applySubtitleCueEvent(state, event('s1', 'source', 'hello', 100)));
  const staleBase = state;
  state = accept(state, { ...state, currentCue: { ...state.currentCue, sourceText: 'hello!' } });
  const revision = state.currentCue.revision;
  const staleProposal = { ...staleBase, currentCue: { ...staleBase.currentCue, refinement: { status: 'complete' } } };
  assert.deepEqual(commitSubtitleCueState(state, staleProposal, { baseState: staleBase }), { accepted: false, state });
  state = accept(state, { ...state, currentCue: { ...state.currentCue, refinement: { status: 'complete' } } });
  assert.equal(state.currentCue.revision, revision + 1);
});

test('different speech turn with same text receives a distinct Cue ID', () => {
  let state = createSubtitleCueState();
  state = accept(state, applySubtitleCueEvent(state, event('s1', 'source', 'same', 100, true)));
  state = accept(state, applySubtitleCueEvent(state, event('t1', 'translation', 'même', 110, true)));
  state = accept(state, finalizePendingSubtitleCue(state, { sessionTimeMs: 120, reason: 'test' }));
  const firstId = state.finalCues[0].cueId;
  state = accept(state, applySubtitleCueEvent(state, { ...event('s2', 'source', 'same', 500, true), turnKey: 'turn-2' }));
  state = accept(state, applySubtitleCueEvent(state, { ...event('t2', 'translation', 'même', 510, true), turnKey: 'turn-2' }));
  state = accept(state, finalizePendingSubtitleCue(state, { sessionTimeMs: 520, reason: 'test' }));
  assert.equal(state.finalCues.length, 2);
  assert.notEqual(state.finalCues[1].cueId, firstId);
});

test('accepted Cue cannot be rekeyed while retaining its session and sequence', () => {
  let state = createSubtitleCueState();
  state = accept(state, applySubtitleCueEvent(state, event('s1', 'source', 'hello', 100)));
  const rekeyed = { ...state, currentCue: { ...state.currentCue, cueId: 'cue:other:1' } };
  assert.throws(() => commitSubtitleCueState(state, rekeyed), /cue_identity_conflict/);
});

test('timing and status changes advance revision; recovered legacy Cue starts at one', () => {
  const legacy = { cueId: 'legacy', sessionId: 's', segmentId: 'seg', sequence: 1,
    status: 'partial', startTimeMs: 0, endTimeMs: 1, sourceText: 'hello' };
  let state = createSubtitleCueState({ currentCue: legacy, nextSequence: 2 });
  state = accept(state, { ...state, currentCue: { ...state.currentCue, endTimeMs: 2 } });
  assert.equal(state.currentCue.revision, 1);
  state = accept(state, { ...state, currentCue: { ...state.currentCue, status: 'final' } });
  assert.equal(state.currentCue.revision, 2);
});


test('provisional unknown-owner Cue is selected for durable storage', () => {
  const provisional = { cueId: 'cue:s:2', sessionId: 's', segmentId: null,
    sequence: 2, revision: 1, status: 'partial', startTimeMs: 1, endTimeMs: 2 };
  const survivor = { ...provisional, cueId: 'cue:s:1', sequence: 1,
    revision: 3, status: 'final' };
  const changes = unassignedCuePersistenceChanges(createSubtitleCueState(),
    createSubtitleCueState({ currentCue: provisional }));
  assert.deepEqual(changes.upserts, [provisional]);
  assert.deepEqual(durableUnassignedFinalCues([survivor]), [survivor]);
});

test('adjacent provisional unknown-owner Cues retain independent persistence records', () => {
  let state = createSubtitleCueState();
  const unknown = (id, stream, text, time) => ({
    eventId: id, sessionId: 's', segmentId: null, stream, text,
    sessionTimeMs: time, isFinal: true, sourceLanguageCode: 'en', targetLanguageCode: 'fr'
  });
  const pair = (source, translation, time) => {
    state = accept(state, applySubtitleCueEvent(state, unknown(`s-${time}`, 'source', source, time)));
    state = accept(state, applySubtitleCueEvent(state, unknown(`t-${time}`, 'translation', translation, time + 10)));
    const beforeFinalization = state;
    state = accept(state, finalizePendingSubtitleCue(state, { sessionTimeMs: time + 20, reason: 'test' }));
    return unassignedCuePersistenceChanges(beforeFinalization, state);
  };
  pair('Actually,', 'En fait,', 100);
  const survivorId = state.finalCues[0].cueId;
  const changes = pair('it works', 'ça marche', 200);
  assert.equal(state.finalCues.length, 2);
  assert.equal(state.finalCues[0].cueId, survivorId);
  assert.equal(changes.upserts[0].cueId, state.finalCues[1].cueId);
  assert.deepEqual(changes.removals, []);
  assert.deepEqual(durableUnassignedFinalCues(state.finalCues).map((cue) => cue.cueId),
    state.finalCues.map((cue) => cue.cueId));
});

test('equivalent Cue fields in a different key order are a no-op', () => {
  let state = createSubtitleCueState();
  state = accept(state, applySubtitleCueEvent(state, event('s1', 'source', 'hello', 100)));
  const cue = state.currentCue;
  const reordered = Object.fromEntries(Object.entries(cue).reverse());
  state = accept(state, { ...state, currentCue: reordered });
  assert.equal(state.currentCue.revision, 1);
});
