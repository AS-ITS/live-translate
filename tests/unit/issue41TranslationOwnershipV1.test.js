import assert from 'node:assert/strict';
import test from 'node:test';
import { applyCueMutation } from '../../src/domain/subtitleCue/cueMutation.js';
import { cueRefinementInputHash, effectiveTranslationForCue } from '../../src/lib/cueContent.js';
import { applyGlossaryCorrectionToCue } from '../../src/lib/glossaryReplacement.js';
import { applyMeetingCueEvent, mergeMeetingViewerSnapshot } from '../../src/lib/meetingViewerState.js';
import { exportCuesToSrt, exportCuesToTxt, exportCuesToVtt } from '../../src/lib/subtitleCueExport.js';
import { createCueMutationCoordinator } from '../../src/lib/cueMutationCoordinator.js';
import { commitSubtitleCueState, createSubtitleCueState } from '../../src/lib/subtitleCues.js';
import { createInMemoryLocalMeetingManifestStore } from '../../src/lib/localMeetingStorage.js';

function cue() {
  const value = {
    cueId: 'cue-1', sessionId: 'session-1', segmentId: 'segment-1', sequence: 1,
    startTimeMs: 0, endTimeMs: 1000, sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en',
    sourceText: '你好', rawSource: '你好', sourceVersion: 1, sourceStatus: 'finalized',
    translatedText: 'A1', rawTranslation: 'A1', initialTranslation: 'A1',
    translationVersion: 1, translationStatus: 'finalized', status: 'final',
    finalizedReason: 'turnComplete', revision: 1, audioTurnId: 'turn-1', turnKey: 'turn-1',
    connectionEpoch: 1, providerEpoch: 1, providerEventSequence: 1,
    translationProvenance: { audioTurnId: 'turn-1', turnKey: 'turn-1', connectionEpoch: 1, providerEpoch: 1, eventSequence: 1 }
  };
  value.refinement = { status: 'pending', version: 1, inputHash: cueRefinementInputHash(value) };
  return value;
}

test('A1 → B1 → A2 → B2 binds display to current Gemini translation', () => {
  const a1 = cue();
  const b1 = { ...a1, refinedTranslation: 'B1', refinement: { ...a1.refinement, status: 'completed' } };
  assert.equal(effectiveTranslationForCue(b1), 'B1');
  const proposed = { ...b1, translatedText: 'A2', rawTranslation: 'A2', initialTranslation: 'A2',
    translationVersion: 2, providerEventSequence: 2,
    translationProvenance: { ...b1.translationProvenance, eventSequence: 2 } };
  const lateFinal = applyCueMutation(b1, { side: 'translation', cue: proposed });
  assert.equal(lateFinal.status, 'committed', JSON.stringify(lateFinal));
  assert.equal(lateFinal.cue.initialTranslation, 'A2');
  assert.equal(effectiveTranslationForCue({ ...lateFinal.cue, refinedTranslation: 'B1', refinement: b1.refinement }), 'A2');
  assert.equal(effectiveTranslationForCue({ ...lateFinal.cue, refinement: { ...lateFinal.cue.refinement, status: 'failed' } }), 'A2');
  const b2 = { ...lateFinal.cue, refinedTranslation: 'B2', refinement: { ...lateFinal.cue.refinement, status: 'completed' } };
  assert.equal(effectiveTranslationForCue(b2), 'B2');
  for (const exportCues of [exportCuesToTxt, exportCuesToSrt, exportCuesToVtt]) {
    const output = exportCues([b2]);
    assert.match(output, /B2/);
    assert.doesNotMatch(output, /B1/);
  }
  const viewer = applyMeetingCueEvent(mergeMeetingViewerSnapshot({ cues: [] }, { cues: [b1] }),
    { type: 'cue.update', eventId: 2, cue: lateFinal.cue });
  assert.equal(effectiveTranslationForCue(viewer.cues[0]), 'A2');
});

test('dictionary correction keeps Gemini Initial and binds Refined', () => {
  const initial = cue();
  initial.rawTranslation = 'Hello';
  initial.translatedText = 'Hello';
  initial.initialTranslation = 'Hello';
  initial.refinement.inputHash = cueRefinementInputHash(initial);
  const corrected = applyGlossaryCorrectionToCue(initial,
    [{ source: '你好', target: 'Hi', replacementAliases: ['Hello'] }]);
  assert.equal(corrected.initialTranslation, 'Hello');
  assert.equal(effectiveTranslationForCue(corrected), 'Hi');
  assert.equal(corrected.refinement.inputHash, cueRefinementInputHash(corrected));
});

test('out-of-order Gemini translation stays rejected', () => {
  const initial = cue();
  const result = applyCueMutation(initial, { side: 'translation', cue: {
    ...initial, translatedText: 'old', rawTranslation: 'old', initialTranslation: 'old',
    translationProvenance: { ...initial.translationProvenance, eventSequence: 0 }
  } });
  assert.equal(result.status, 'rejected');
  assert.equal(initial.initialTranslation, 'A1');
});

test('same batch A2 invalidates pending B1 after proven Initial commit', async () => {
  const store = createInMemoryLocalMeetingManifestStore();
  const a1 = cue();
  store.commitCueMutation({ meetingId: 'meeting-1', segmentId: a1.segmentId,
    side: 'initial', cue: a1, eventKey: 'initial-1' });
  const staleB1 = { ...a1, translatedText: 'A2', rawTranslation: 'A2', initialTranslation: 'A2',
    translationVersion: 2, providerEventSequence: 2,
    translationProvenance: { ...a1.translationProvenance, eventSequence: 2 },
    refinedTranslation: 'B1', refinement: { ...a1.refinement, status: 'completed' } };
  const coordinator = createCueMutationCoordinator({
    commit: (job) => store.commitCueMutation(job), createEventKey: (() => {
      let sequence = 1; return () => `event-${++sequence}`;
    })()
  });
  const results = await coordinator.enqueue({ meetingId: 'meeting-1', segmentId: a1.segmentId,
    changes: [{ before: a1, cue: staleB1 }] });
  assert.deepEqual(results.map(({ job, result }) => [job.side, result.status]),
    [['translation', 'committed'], ['refinement', 'duplicate']]);
  assert.equal(results[1].result.reason, 'stale_refinement_invalidated');
  assert.deepEqual(await coordinator.flush(), []);
  const saved = (await store.listCues('meeting-1'))[0].cue;
  assert.equal(saved.initialTranslation, 'A2');
  assert.equal(saved.refinedTranslation, null);
  assert.equal(effectiveTranslationForCue(saved), 'A2');
});

test('unbound legacy Refined falls back without changing Local Cue', () => {
  const legacy = { ...cue(), refinedTranslation: 'old B1', refinement: { status: 'completed', version: 2 } };
  assert.equal(effectiveTranslationForCue(legacy), 'A1');
  assert.equal(legacy.refinedTranslation, 'old B1');
});

test('mixed hash, version, or provenance cannot commit Refined', () => {
  const initial = cue();
  const refined = { ...initial, refinedTranslation: 'B1',
    refinement: { ...initial.refinement, status: 'completed' } };
  for (const mixed of [
    { ...refined, translationVersion: 2 },
    { ...refined, translationProvenance: { ...initial.translationProvenance, eventSequence: 2 } },
    { ...refined, refinement: { ...refined.refinement, inputHash: 'fnv1a-deadbeef' } }
  ]) {
    const result = applyCueMutation(initial, { side: 'refinement', cue: mixed });
    assert.deepEqual([result.status, result.reason], ['rejected', 'cue_refinement_input_conflict']);
    assert.equal(initial.initialTranslation, 'A1');
  }
});

test('same-batch duplicate Initial safely discards only an empty unproven pending reset', async () => {
  const initial = cue();
  const unproven = { ...initial, translationProvenance: {
    ...initial.translationProvenance, eventSequence: null
  } };
  unproven.refinement = { status: 'pending', version: 1, inputHash: cueRefinementInputHash(unproven) };
  const run = async (incoming) => {
    let stored = initial;
    const coordinator = createCueMutationCoordinator({
      commit(job) {
        const result = applyCueMutation(stored, job);
        if (result.status === 'committed') stored = result.cue;
        return result;
      }, createEventKey: (() => { let n = 0; return () => `duplicate-${++n}`; })()
    });
    const results = await coordinator.enqueue({ meetingId: 'meeting-1', segmentId: initial.segmentId,
      changes: [{ before: initial, cue: incoming }] });
    return { results, stored, failures: await coordinator.flush() };
  };
  const pending = await run(unproven);
  assert.deepEqual(pending.results.map(({ job, result }) => [job.side, result.status]),
    [['translation', 'duplicate'], ['refinement', 'duplicate']]);
  assert.deepEqual(pending.failures, []);
  assert.equal(pending.stored.initialTranslation, 'A1');
  assert.equal(pending.stored.translationProvenance.eventSequence, 1);
  const completed = await run({ ...unproven, refinedTranslation: 'unproven B',
    refinement: { ...unproven.refinement, status: 'completed' } });
  assert.equal(completed.results[1].result.reason, 'cue_refinement_input_conflict');
  const wrongVersion = await run({ ...unproven, translationVersion: 2,
    refinement: { ...unproven.refinement, inputHash: cueRefinementInputHash({ ...unproven, translationVersion: 2 }) } });
  assert.equal(wrongVersion.results[1].result.reason, 'cue_refinement_input_conflict');
});

test('Live null provenance fields bind source and refinement to one committed Initial', async () => {
  const local = { ...cue(), translationProvenance: {
    ...cue().translationProvenance, providerEventId: null, eventId: null
  } };
  local.refinement = { status: 'pending', version: 1, inputHash: cueRefinementInputHash(local) };
  const initial = applyCueMutation(null, { side: 'initial', cue: local });
  assert.equal(initial.status, 'committed');
  const a1 = initial.cue;
  const state = createSubtitleCueState({ finalCues: [local] });
  const proposed = { ...local, sourceText: '你好世界', rawSource: '你好世界',
    sourceVersion: 2, providerEventSequence: 2,
    sourceProvenance: { audioTurnId: 'turn-1', turnKey: 'turn-1', providerEventId: null,
      eventId: 'source-2', connectionEpoch: 1, providerEpoch: 1, eventSequence: 2 } };
  const incoming = commitSubtitleCueState(state, { ...state, finalCues: [proposed] }).state.finalCues[0];
  assert.equal(incoming.translationVersion, 1);
  assert.equal(incoming.translationProvenance.eventSequence, 1);
  let stored = a1;
  const coordinator = createCueMutationCoordinator({
    commit(job) {
      const result = applyCueMutation(stored, job);
      if (result.status === 'committed') stored = result.cue;
      return result;
    },
    createEventKey: (() => { let n = 0; return () => `null-provenance-${++n}`; })()
  });
  const results = await coordinator.enqueue({ meetingId: 'meeting-1', segmentId: a1.segmentId,
    changes: [{ before: local, cue: incoming }] });
  assert.ok(results.every(({ result }) => result), JSON.stringify(results.map(({ job, error }) => ({ side: job.side, error: error?.message }))));
  assert.deepEqual(results.map(({ job, result }) => [job.side, result.status]),
    [['source', 'committed'], ['refinement', 'duplicate']]);
  assert.deepEqual(await coordinator.flush(), []);
  assert.equal(stored.sourceVersion, 2);
  assert.equal(stored.translationVersion, 1);
  assert.equal(stored.translationProvenance.eventSequence, 1);
  assert.equal(stored.refinement.inputHash, cueRefinementInputHash(stored));
});
