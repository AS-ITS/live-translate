import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cueRefinementInputHash,
  effectiveSourceForCue,
  effectiveTranslationForCue,
  normalizeCueRefinement
} from '../../src/lib/cueContent.js';

test('effective Cue content prefers refined values and supports raw inspection', () => {
  const cue = { cueId: 'cue-1', sequence: 1, rawSource: 'raw source', rawTranslation: 'raw translation', refinedSource: 'refined source', refinedTranslation: 'refined translation' };
  assert.equal(effectiveSourceForCue(cue), 'refined source');
  assert.equal(effectiveTranslationForCue(cue), 'refined translation');
  assert.equal(effectiveSourceForCue(cue, 'raw'), 'raw source');
  assert.equal(effectiveTranslationForCue(cue, 'raw'), 'raw translation');
});

test('Cue refinement metadata resets when raw input hash changes', () => {
  const cue = { cueId: 'cue-1', sequence: 1, rawSource: 'source', rawTranslation: 'translation', refinement: { status: 'completed', version: 4, inputHash: 'old' } };
  const normalized = normalizeCueRefinement(cue);
  assert.equal(normalized.status, 'pending');
  assert.equal(normalized.version, 1);
  assert.equal(normalized.inputHash, cueRefinementInputHash(cue));
});
