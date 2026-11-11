import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { applyCueMutation } from '../../src/domain/subtitleCue/cueMutation.js';
import { cueRefinementInputHash } from '../../src/lib/cueContent.js';
import { projectAdjacentFinalCues } from '../../src/lib/adjacentCueProjection.js';
import { createCueMutationCoordinator, cueMutationsForChange } from '../../src/lib/cueMutationCoordinator.js';
import { applyGlossaryCorrectionToCue } from '../../src/lib/glossaryReplacement.js';
import { applySubtitleCueEvent, commitSubtitleCueState, createSubtitleCueState, finalizePendingSubtitleCue } from '../../src/lib/subtitleCues.js';

function fixture() {
  const cue = {
    cueId: 'cue-fixture', sessionId: 'session-fixture', segmentId: 'segment-fixture',
    sequence: 1, startTimeMs: 0, endTimeMs: 100,
    sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en',
    sourceText: 'source,', rawSource: 'source,', sourceVersion: 1, sourceStatus: 'finalized',
    translatedText: 'display,', rawTranslation: 'raw alpha', initialTranslation: 'display,',
    translationVersion: 1, translationStatus: 'finalized',
    status: 'final', finalizedReason: 'turnComplete', revision: 1,
    providerEventSequence: 193, audioTurnId: 'turn-fixture', turnKey: 'turn-fixture',
    refinedSource: null, refinedTranslation: null
  };
  cue.refinement = { status: 'pending', version: 1, inputHash: cueRefinementInputHash(cue) };
  return cue;
}

function transition(before, proposed) {
  const state = createSubtitleCueState({ finalCues: [before] });
  return commitSubtitleCueState(state, { ...state, finalCues: [proposed] }).state.finalCues[0];
}

function flags(before, after) {
  return {
    rawTranslationChanged: before.rawTranslation !== after.rawTranslation,
    translationVersionChanged: before.translationVersion !== after.translationVersion,
    newTranslationProvenance: JSON.stringify(before.translationProvenance ?? null) !== JSON.stringify(after.translationProvenance ?? null)
  };
}

function loadAppOutputApplier({ stateRef, commitCueState }) {
  const source = readFileSync(new URL('../../src/app/App.jsx', import.meta.url), 'utf8');
  const start = source.indexOf('  function applyInitialTranslationOutputs(detail) {');
  const end = source.indexOf('  function applyPolishedOutput(output) {', start);
  assert.ok(start >= 0 && end > start, 'App output applier must be found');
  const declaration = source.slice(start, end);
  return new Function('subtitleCueStateRef', 'targetLanguageCode', 'applyGlossaryCorrectionToCue',
    'correctionGlossaryEntriesForCue', 'commitCueState', 'scheduleTranscriptPolishing',
    'transcriptPolishingCoordinator', `${declaration}\nreturn applyInitialTranslationOutputs;`)(
    stateRef, 'en', applyGlossaryCorrectionToCue, () => [], commitCueState,
    () => Promise.resolve(), () => ({ flush: () => Promise.resolve() })
  );
}

test('new Live translation event advances version and records new provenance', () => {
  const before = fixture();
  const state = createSubtitleCueState({ finalCues: [before] });
  const next = applySubtitleCueEvent(state, {
    eventId: 'event-194', stream: 'translation', text: 'display updated,',
    providerRawText: 'raw beta', eventSequence: 194, sessionTimeMs: 110,
    audioTurnId: 'turn-fixture', turnKey: 'turn-fixture',
    sessionId: before.sessionId, segmentId: before.segmentId,
    sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en', isFinal: true
  });
  const after = next.finalCues.find((cue) => cue.cueId === before.cueId);
  assert.ok(after, 'the existing Cue must receive the Live event');
  assert.deepEqual(flags(before, after), {
    rawTranslationChanged: true, translationVersionChanged: true, newTranslationProvenance: true
  });
  assert.equal(after.translationProvenance.eventSequence, 194);
});

test('adjacent Final Cues retain separate authority and Queue receives no fabricated translation', async () => {
  const before = fixture();
  let state = createSubtitleCueState({ finalCues: [before], nextSequence: 2 });
  const common = { sessionId: before.sessionId, segmentId: before.segmentId,
    sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en', isFinal: true };
  state = applySubtitleCueEvent(state, { ...common, eventId: 'source-194', stream: 'source',
    text: 'source,', eventSequence: 194, sessionTimeMs: 120 });
  state = applySubtitleCueEvent(state, { ...common, eventId: 'translation-195', stream: 'translation',
    text: 'display', providerRawText: 'raw beta', eventSequence: 195, sessionTimeMs: 130 });
  state = finalizePendingSubtitleCue(state, { sessionTimeMs: 140, reason: 'test' });
  const after = state.finalCues.find((cue) => cue.cueId === before.cueId);
  assert.ok(after);
  assert.equal(state.finalCues.length, 2);
  assert.notEqual(state.finalCues[1].cueId, before.cueId);
  assert.equal(state.finalCues[1].rawTranslation, 'raw beta');
  assert.equal(projectAdjacentFinalCues(state.finalCues).length, 2);
  assert.deepEqual(flags(before, after), {
    rawTranslationChanged: false, translationVersionChanged: false, newTranslationProvenance: false
  });
  assert.equal(after.providerEventSequence, 193);
  const committed = transition(before, after);
  const coordinator = createCueMutationCoordinator({
    commit: (job) => applyCueMutation(before, job),
    createEventKey: (() => { let n = 0; return () => `merge-${++n}`; })()
  });
  const results = await coordinator.enqueue({ meetingId: 'meeting-fixture', segmentId: before.segmentId,
    changes: [{ before, cue: committed }] });
  assert.deepEqual(results, []);
  assert.deepEqual(await coordinator.flush(), []);
});

test('App output applier preserves committed raw translation without Live provenance', () => {
  const before = fixture();
  const stateRef = { current: createSubtitleCueState({ finalCues: [before] }) };
  const applyOutput = loadAppOutputApplier({ stateRef, commitCueState(previous, proposed) {
    stateRef.current = commitSubtitleCueState(stateRef.current, proposed, { baseState: previous }).state;
  } });
  applyOutput({ translationHistory: { outputs: [{ operation: 'cue_translation', cueId: before.cueId,
    translatedText: 'output beta' }] } });
  const after = stateRef.current.finalCues[0];
  assert.deepEqual(flags(before, after), {
    rawTranslationChanged: false, translationVersionChanged: false, newTranslationProvenance: false
  });
  assert.equal(after.providerEventSequence, 193);
});

test('same invalid Cue snapshot is rejected for translation then refinement', async () => {
  const stored = fixture();
  let incoming = transition(stored, { ...stored, rawTranslation: 'raw beta',
    initialTranslation: 'display beta', translatedText: 'display beta' });
  for (let index = 0; index < 3; index += 1) {
    incoming = transition(incoming, { ...incoming, updatedTimeMs: 200 + index });
  }
  assert.equal(incoming.revision, 5);
  assert.equal(incoming.providerEventSequence, 193);
  assert.deepEqual(flags(stored, incoming), {
    rawTranslationChanged: true, translationVersionChanged: false, newTranslationProvenance: false
  });
  const coordinator = createCueMutationCoordinator({
    commit: (job) => applyCueMutation(stored, job),
    createEventKey: (() => { let n = 0; return () => `fixture-${++n}`; })()
  });
  const results = await coordinator.enqueue({ meetingId: 'meeting-fixture', segmentId: stored.segmentId,
    changes: [{ before: stored, cue: incoming }] });
  assert.deepEqual(results.map(({ job, result }) => [job.side, result.status, result.reason]), [
    ['translation', 'rejected', 'cue_translation_event_unproven'],
    ['refinement', 'rejected', 'cue_refinement_input_conflict']
  ]);
  assert.equal(results[0].job.cue, results[1].job.cue);
  const failures = await coordinator.flush();
  assert.equal(failures.length, 1);
  assert.equal(failures[0].job.side, 'translation');
});

async function commitSideQueue(before, incoming) {
  let stored = before;
  const coordinator = createCueMutationCoordinator({
    commit(job) {
      const result = applyCueMutation(stored, job);
      if (result.status === 'committed') stored = result.cue;
      return result;
    },
    createEventKey: (() => { let index = 0; return () => `side-${++index}`; })()
  });
  const results = await coordinator.enqueue({
    meetingId: 'meeting-fixture', segmentId: before.segmentId,
    changes: [{ before, cue: incoming }]
  });
  return { stored, results, failures: await coordinator.flush() };
}

test('source and refinement commit without a new translation event', async () => {
  const before = { ...fixture(), connectionEpoch: 1, providerEpoch: 1 };
  const incoming = { ...before, sourceText: 'source, continuation', rawSource: 'source, continuation',
    sourceVersion: 2, revision: 2, providerEventSequence: 194,
    sourceProvenance: { audioTurnId: 'turn-fixture', turnKey: 'turn-fixture',
      connectionEpoch: 1, providerEpoch: 1, eventSequence: 194 } };
  incoming.refinement = { status: 'pending', version: 1, inputHash: cueRefinementInputHash(incoming) };
  assert.deepEqual(cueMutationsForChange(before, incoming).map(({ side }) => side), ['source', 'refinement']);
  const { stored, results, failures } = await commitSideQueue(before, incoming);
  assert.deepEqual(results.map(({ job, result }) => [job.side, result.status]),
    [['source', 'committed'], ['refinement', 'duplicate']]);
  assert.equal(failures.length, 0);
  assert.equal(stored.sourceVersion, 2);
  assert.equal(stored.rawSource, incoming.rawSource);
  assert.equal(stored.translatedText, before.translatedText);
  assert.equal(stored.rawTranslation, before.rawTranslation);
  assert.equal(stored.translationVersion, before.translationVersion);
  assert.equal(stored.providerEventSequence, 194);
  assert.equal(stored.refinement.inputHash, cueRefinementInputHash(stored));
});

test('source then proven translation commit before refinement and reload', async () => {
  const before = { ...fixture(), connectionEpoch: 1, providerEpoch: 1,
    translationProvenance: { audioTurnId: 'turn-fixture', turnKey: 'turn-fixture',
      connectionEpoch: 1, providerEpoch: 1, eventSequence: 193 } };
  const incoming = { ...before, sourceText: 'source, continuation', rawSource: 'source, continuation',
    sourceVersion: 2, translatedText: 'display, continuation', rawTranslation: 'raw alpha beta',
    initialTranslation: 'display, continuation', translationVersion: 2,
    sourceProvenance: { audioTurnId: 'turn-fixture', turnKey: 'turn-fixture',
      connectionEpoch: 1, providerEpoch: 1, eventSequence: 194 },
    providerEventSequence: 195, translationProvenance: { ...before.translationProvenance, eventSequence: 195 },
    revision: 2 };
  incoming.refinement = { status: 'pending', version: 1, inputHash: cueRefinementInputHash(incoming) };
  const { stored, results, failures } = await commitSideQueue(before, incoming);
  assert.deepEqual(results.map(({ job, result }) => [job.side, result.status]),
    [['source', 'committed'], ['translation', 'committed'], ['refinement', 'duplicate']]);
  assert.equal(results[0].result.cue.translatedText, before.translatedText);
  assert.equal(results[0].result.cue.providerEventSequence, 194);
  assert.equal(results[0].result.cue.translationProvenance.eventSequence, 193);
  assert.equal(failures.length, 0);
  assert.equal(stored.translationVersion, 2);
  assert.equal(stored.translationProvenance.eventSequence, 195);
  assert.equal(stored.rawTranslation, incoming.rawTranslation);
  assert.equal(stored.translatedText, incoming.translatedText);
  assert.equal(stored.initialTranslation, incoming.initialTranslation);
  assert.equal(stored.refinement.inputHash, cueRefinementInputHash(stored));
  const reloaded = createSubtitleCueState(JSON.parse(JSON.stringify({ finalCues: [stored] }))).finalCues[0];
  assert.equal(reloaded.rawTranslation, stored.rawTranslation);
  assert.equal(reloaded.translatedText, stored.translatedText);
  assert.equal(reloaded.translationVersion, stored.translationVersion);
  assert.deepEqual(reloaded.translationProvenance, stored.translationProvenance);
});

test('consecutive Cue jobs keep each stored Side and reject stale translation proof', async () => {
  const first = { ...fixture(), connectionEpoch: 1, providerEpoch: 1 };
  const second = { ...fixture(), cueId: 'cue-second', sequence: 2, startTimeMs: 200,
    endTimeMs: 300, connectionEpoch: 1, providerEpoch: 1,
    translationProvenance: { audioTurnId: 'turn-fixture', turnKey: 'turn-fixture',
      connectionEpoch: 1, providerEpoch: 1, eventSequence: 193 } };
  second.refinement = { status: 'pending', version: 1, inputHash: cueRefinementInputHash(second) };
  const firstNext = { ...first, sourceText: 'source, more', rawSource: 'source, more',
    sourceVersion: 2, providerEventSequence: 194,
    sourceProvenance: { audioTurnId: 'turn-fixture', turnKey: 'turn-fixture',
      connectionEpoch: 1, providerEpoch: 1, eventSequence: 194 } };
  firstNext.refinement = { status: 'pending', version: 1, inputHash: cueRefinementInputHash(firstNext) };
  const secondNext = { ...second, translatedText: 'display, more', rawTranslation: 'raw alpha more',
    initialTranslation: 'display, more', translationVersion: 2, providerEventSequence: 195,
    translationProvenance: { ...second.translationProvenance, eventSequence: 195 } };
  secondNext.refinement = { status: 'pending', version: 1, inputHash: cueRefinementInputHash(secondNext) };
  const stored = new Map([[first.cueId, first], [second.cueId, second]]);
  const coordinator = createCueMutationCoordinator({
    commit(job) {
      const result = applyCueMutation(stored.get(job.cue.cueId), job);
      if (result.status === 'committed') stored.set(job.cue.cueId, result.cue);
      return result;
    },
    createEventKey: (() => { let index = 0; return () => `multi-${++index}`; })()
  });
  const results = await coordinator.enqueue({ meetingId: 'meeting-fixture', segmentId: first.segmentId,
    changes: [{ before: first, cue: firstNext }, { before: second, cue: secondNext }] });
  assert.ok(results.every(({ result }) => result.status !== 'rejected'));
  assert.equal((await coordinator.flush()).length, 0);
  assert.equal(stored.get(first.cueId).rawTranslation, first.rawTranslation);
  assert.equal(stored.get(second.cueId).rawSource, second.rawSource);
  const stale = { ...secondNext, rawTranslation: 'stale raw', translatedText: 'stale display',
    translationVersion: 3, providerEventSequence: 194,
    translationProvenance: { ...second.translationProvenance, eventSequence: 194 } };
  assert.equal(applyCueMutation(stored.get(second.cueId), { side: 'translation', cue: stale }).status, 'rejected');
  assert.equal(stored.get(second.cueId).translationProvenance.eventSequence, 195);
});
