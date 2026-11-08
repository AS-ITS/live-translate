import assert from 'node:assert/strict';
import test from 'node:test';
import { explainCueCoverageFailure } from '../../src/lib/meetingCheckpointSyncCoordinator.js';
import { validateFinalCue } from '../../src/domain/subtitleCue/index.js';

const base = () => ({
  cueId: 'cue-1', sessionId: 'session-1', segmentId: 'segment-1',
  sequence: 1, startTimeMs: 0, endTimeMs: 100,
  sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en',
  sourceText: 'fixture source', translatedText: 'fixture translation',
  status: 'final', finalizedReason: 'final'
});

function check(reason, change, expected = {}) {
  test(reason, () => {
    const persisted = base();
    const pending = base();
    change(persisted, pending);
    const result = explainCueCoverageFailure(persisted, pending);
    assert.deepEqual(result, { reason, ...expected });
    assert.doesNotMatch(JSON.stringify(result), /fixture source|fixture translation/);
  });
}

test('cue_missing', () => {
  assert.deepEqual(explainCueCoverageFailure(undefined, base()), { reason: 'cue_missing' });
});
check('cue_identity_mismatch', (p) => { p.cueId = 'cue-2'; }, { field: 'cueId' });
check('cue_identity_mismatch', (p) => { p.sessionId = 'session-2'; }, { field: 'sessionId' });
check('cue_identity_mismatch', (p) => { p.segmentId = 'segment-2'; }, { field: 'segmentId' });
check('legacy_cue_not_covered', (p) => { delete p.sourceLanguageCode; });
for (const [field, value] of [
  ['sequence', 2], ['startTimeMs', 1], ['sourceLanguageCode', 'en'],
  ['targetLanguageCode', 'zh-Hant'], ['finalizedReason', 'generationComplete']
]) {
  check('cue_field_mismatch', (p) => { p[field] = value; }, { field });
}
check('cue_end_time_behind', (p) => { p.endTimeMs = 90; });
check('cue_side_version_behind', (p, q) => { p.sourceVersion = 1; q.sourceVersion = 2; }, { side: 'source' });
check('cue_side_content_mismatch', (p) => { p.sourceText = 'different'; }, { side: 'source' });
check('cue_side_status_mismatch', (p) => { p.sourceStatus = 'pending'; }, { side: 'source' });
check('cue_side_prefix_mismatch', (p, q) => {
  p.sourceVersion = 2; q.sourceVersion = 1; p.sourceText = 'different';
}, { side: 'source' });
check('cue_side_status_transition_mismatch', (p, q) => {
  p.sourceVersion = 2; q.sourceVersion = 1; p.sourceStatus = 'unavailable';
}, { side: 'source' });
check('cue_end_time_advanced_without_version', (p) => { p.endTimeMs = 110; });

const refined = () => ({
  ...base(), rawSource: 'fixture source', rawTranslation: 'fixture translation',
  initialTranslation: null, refinedSource: null, refinedTranslation: null,
  refinement: { status: 'pending', version: 1 }
});
function checkRefinement(reason, change) {
  test(reason, () => {
    const persisted = refined();
    const pending = refined();
    change(persisted, pending);
    const result = explainCueCoverageFailure(persisted, pending);
    assert.equal(result.reason, reason, JSON.stringify(result));
    assert.doesNotMatch(JSON.stringify(result), /fixture source|fixture translation/);
  });
}
checkRefinement('cue_refinement_missing', (p) => {
  delete p.rawSource; delete p.rawTranslation; delete p.initialTranslation;
  delete p.refinedSource; delete p.refinedTranslation; delete p.refinement;
});
checkRefinement('cue_initial_translation_mismatch', (p, q) => {
  p.initialTranslation = 'other'; q.initialTranslation = 'fixture translation';
});
checkRefinement('cue_initial_translation_version_not_advanced', (p) => {
  p.initialTranslation = 'other';
});
checkRefinement('cue_refinement_version_behind', (p, q) => { p.refinement.version = 1; q.refinement.version = 2; });
checkRefinement('cue_refinement_same_version_mismatch', (p) => { p.refinement.status = 'completed'; });
checkRefinement('cue_refined_source_mismatch', (p) => { p.refinedSource = 'other'; });
checkRefinement('cue_refined_translation_mismatch', (p) => { p.refinedTranslation = 'other'; });
checkRefinement('cue_refinement_input_hash_mismatch', (p) => {
  p.refinement.version = 2; p.refinement.inputHash = 'different';
});
checkRefinement('cue_refinement_completion_missing', (p, q) => {
  p.refinement.version = 2; q.refinement.status = 'completed';
});
checkRefinement('cue_refined_source_missing', (p, q) => {
  p.refinement.version = 2; q.refinedSource = 'other';
});
checkRefinement('cue_refined_translation_missing', (p, q) => {
  p.refinement.version = 2; q.refinedTranslation = 'other';
});

test('normalized base fixture is valid and same cue is covered', () => {
  assert.equal(validateFinalCue(base()).cueId, 'cue-1');
  assert.deepEqual(explainCueCoverageFailure(base(), base()), { reason: 'cue_covered' });
});
