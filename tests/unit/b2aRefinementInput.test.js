import assert from 'node:assert/strict';
import test from 'node:test';
import { cueRefinementInputHash } from '../../src/lib/cueContent.js';
import { applyRefinementResultToCues, markCueRefinementSubmitted } from '../../src/lib/cueRefinement.js';
import { commitSubtitleCueState, createSubtitleCueState } from '../../src/lib/subtitleCues.js';
import { applyCompletedRefinementOutputs } from '../../src/features/live/liveRecordingController.js';

function cue(cueId = 'cue:s:seg:1') {
  const value = { cueId, sessionId: 's', segmentId: 'seg', sequence: cueId.endsWith(':2') ? 2 : 1,
    revision: 1, status: 'final', startTimeMs: 0, endTimeMs: 100,
    rawSource: 'source', rawTranslation: 'translation' };
  return { ...value, refinement: { status: 'pending', version: 1,
    inputHash: cueRefinementInputHash(value) } };
}

test('submission accepts current input, keeps unrelated Cue, and increments whole-Cue revision once', () => {
  const first = cue();
  const unrelated = cue('cue:s:seg:2');
  const latest = createSubtitleCueState({ finalCues: [first, unrelated] });
  const result = markCueRefinementSubmitted(latest.finalCues, first.cueId, {
    inputHash: cueRefinementInputHash(first), version: 1, executionId: 'job-1'
  });
  assert.equal(result.accepted, true);
  assert.equal(result.cues[1], latest.finalCues[1]);
  const committed = commitSubtitleCueState(latest, { ...latest, finalCues: result.cues });
  assert.equal(committed.state.finalCues[0].revision, 2);
  assert.equal(committed.state.finalCues[1].revision, 1);
});

test('stale submission and result cannot alter content, metadata, or whole-Cue revision', () => {
  const original = cue();
  const oldHash = cueRefinementInputHash(original);
  const changed = { ...original, rawSource: 'new source', revision: 2 };
  const latest = createSubtitleCueState({ finalCues: [changed] });
  const submission = markCueRefinementSubmitted(latest.finalCues, original.cueId, {
    inputHash: oldHash, version: 1, executionId: 'old-job'
  });
  assert.equal(submission.accepted, false);
  assert.equal(submission.cues, latest.finalCues);
  const result = applyRefinementResultToCues(latest.finalCues, {
    targetCueId: original.cueId, version: 1, inputHash: oldHash,
    fields: ['translation'], refinedTranslation: 'stale output'
  }, { logger: () => {} });
  assert.equal(result.applied, false);
  assert.equal(result.cues, latest.finalCues);
  assert.equal(latest.finalCues[0].revision, 2);
});

test('translation input change rejects stale result; valid result survives unrelated Cue change', () => {
  const first = cue();
  const hash = cueRefinementInputHash(first);
  const translationChanged = { ...first, rawTranslation: 'new translation' };
  const stale = applyRefinementResultToCues([translationChanged], {
    targetCueId: first.cueId, version: 1, inputHash: hash,
    fields: ['translation'], refinedTranslation: 'old output'
  }, { logger: () => {} });
  assert.equal(stale.applied, false);
  const unrelated = { ...cue('cue:s:seg:2'), rawSource: 'unrelated change' };
  const valid = applyRefinementResultToCues([first, unrelated], {
    targetCueId: first.cueId, version: 1, inputHash: hash,
    fields: ['translation'], refinedTranslation: 'valid output'
  }, { logger: () => {} });
  assert.equal(valid.applied, true);
  assert.equal(valid.cues[0].refinedTranslation, 'valid output');
  assert.equal(valid.cues[1], unrelated);
});

test('older result cannot replace newer refinement for same input', () => {
  const first = cue();
  const hash = cueRefinementInputHash(first);
  const newer = { ...first, refinement: { status: 'completed', version: 2, inputHash: hash },
    refinedTranslation: 'new result' };
  const result = applyRefinementResultToCues([newer], {
    targetCueId: first.cueId, version: 1, inputHash: hash,
    fields: ['translation'], refinedTranslation: 'old result'
  }, { logger: () => {} });
  assert.equal(result.applied, false);
  assert.equal(result.cues[0].refinedTranslation, 'new result');
});

test('accepted result increments whole-Cue revision once; repeated result is a no-op', () => {
  const first = cue();
  const latest = createSubtitleCueState({ finalCues: [first] });
  const result = applyRefinementResultToCues(latest.finalCues, {
    targetCueId: first.cueId, version: 1, inputHash: cueRefinementInputHash(first),
    fields: ['translation'], refinedTranslation: 'refined'
  }, { logger: () => {} });
  assert.equal(result.applied, true);
  const committed = commitSubtitleCueState(latest, { ...latest, finalCues: result.cues }).state;
  assert.equal(committed.finalCues[0].revision, 2);
  const retry = applyRefinementResultToCues(committed.finalCues, {
    targetCueId: first.cueId, version: 1, inputHash: cueRefinementInputHash(first),
    fields: ['translation'], refinedTranslation: 'refined'
  }, { logger: () => {} });
  assert.equal(commitSubtitleCueState(committed, { ...committed, finalCues: retry.cues })
    .state.finalCues[0].revision, 2);
});

test('raw input change invalidates old refinement metadata at the Cue commit boundary', () => {
  const first = { ...cue(), refinedTranslation: 'old output',
    refinement: { status: 'queued', version: 1, inputHash: cueRefinementInputHash(cue()),
      executionId: 'old-job' } };
  const latest = createSubtitleCueState({ finalCues: [first] });
  const changed = { ...latest.finalCues[0], rawSource: 'new source' };
  const committed = commitSubtitleCueState(latest, { ...latest, finalCues: [changed] }).state.finalCues[0];
  assert.equal(committed.revision, 2);
  assert.equal(committed.refinement.inputHash, cueRefinementInputHash(committed));
  assert.equal(committed.refinement.status, 'pending');
  assert.equal(committed.refinement.executionId, undefined);
  assert.equal(committed.refinedTranslation, null);
});

test('polling rejects stale refined output and leaves Cue metadata untouched', () => {
  const original = cue();
  const oldHash = cueRefinementInputHash(original);
  const current = { ...original, rawSource: 'new source', revision: 2,
    refinement: { status: 'pending', version: 1, inputHash: cueRefinementInputHash({ ...original, rawSource: 'new source' }) } };
  const result = applyCompletedRefinementOutputs([current], [{
    operation: 'transcript_polishing', sessionId: 's', executionId: 'old-job',
    completedAt: '2026-01-01T00:00:00.000Z',
    refinementTargets: [{ targetCueId: current.cueId, inputHash: oldHash, version: 1 }],
    refinedItems: [{ targetCueId: current.cueId, refinedTranslation: 'stale output' }],
    refinedCues: [{ sourceCueIds: [current.cueId] }],
  }], { sessionId: 's', logger: () => {} });
  assert.equal(result.changed, false);
  assert.equal(result.cues[0], current);
});

test('polling cannot complete a hashed Cue without output input identity', () => {
  const current = cue();
  const result = applyCompletedRefinementOutputs([current], [{
    operation: 'transcript_polishing', completedAt: '2026-01-01T00:00:00.000Z',
    refinedCues: [{ sourceCueIds: [current.cueId] }]
  }], { sessionId: 's', logger: () => {} });
  assert.equal(result.changed, false);
  assert.equal(result.cues[0], current);
});

test('hashless result cannot overwrite a newer Cue or trigger commit and persistence', () => {
  const old = cue();
  const current = { ...old, rawSource: 'new source', revision: 2,
    refinedTranslation: 'newer refinement',
    refinement: { status: 'completed', version: 2,
      inputHash: cueRefinementInputHash({ ...old, rawSource: 'new source' }) } };
  assert.notEqual(cueRefinementInputHash(old), cueRefinementInputHash(current));
  const unrelated = cue('cue:s:seg:2');
  const state = createSubtitleCueState({ finalCues: [current, unrelated] });
  const output = { sessionId: 's', executionId: 'old-job',
    refinedItems: [{ targetCueId: current.cueId, version: 2,
      fields: ['translation'], refinedTranslation: 'stale output' }] };
  const result = applyCompletedRefinementOutputs(state.finalCues, [output],
    { sessionId: 's', logger: () => {} });
  assert.equal(result.changed, false);
  assert.equal(result.cues[0], state.finalCues[0]);
  assert.equal(result.cues[0].refinedTranslation, 'newer refinement');
  assert.equal(result.cues[1], state.finalCues[1]);
  const committed = commitSubtitleCueState(state, { ...state, finalCues: result.cues }).state;
  assert.equal(committed.finalCues[0].revision, 2);
  let persistenceEnqueues = 0;
  if (result.changed) persistenceEnqueues += 1; // Mirrors App's changed guard.
  assert.equal(persistenceEnqueues, 0);

  const queued = { ...current, refinedTranslation: null,
    refinement: { ...current.refinement, status: 'queued' } };
  const valid = applyCompletedRefinementOutputs([queued, unrelated], [{
    ...output, refinementTargets: [{ targetCueId: current.cueId,
      version: 2, inputHash: cueRefinementInputHash(current) }]
  }], { sessionId: 's', logger: () => {} });
  assert.equal(valid.changed, true);
  assert.equal(valid.cues[0].refinedTranslation, 'stale output');
  assert.equal(valid.cues[1], unrelated);
});
