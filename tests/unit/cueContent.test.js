import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cueRefinementInputHash,
  effectiveSourceForCue,
  effectiveTranslationForCue,
  normalizeCueRefinement
} from '../../src/lib/cueContent.js';

test('effective Cue content falls back to Initial for an unbound legacy Refined', () => {
  const cue = { cueId: 'cue-1', sequence: 1, rawSource: 'raw source', rawTranslation: 'raw translation', refinedSource: 'refined source', refinedTranslation: 'refined translation' };
  assert.equal(effectiveSourceForCue(cue), 'refined source');
  assert.equal(effectiveTranslationForCue(cue), 'raw translation');
  assert.equal(effectiveSourceForCue(cue, 'raw'), 'raw source');
  assert.equal(effectiveTranslationForCue(cue, 'raw'), 'raw translation');
});

test('effective Cue translation uses corrected initial value while raw inspection preserves provider output', () => {
  const cue = { rawTranslation: 'Hi.', initialTranslation: 'speak Hi.' };
  assert.equal(effectiveTranslationForCue(cue), 'speak Hi.');
  assert.equal(effectiveTranslationForCue(cue, 'raw'), 'Hi.');
});

test('Cue refinement metadata resets when raw input hash changes', () => {
  const cue = { cueId: 'cue-1', sequence: 1, rawSource: 'source', rawTranslation: 'translation', refinement: { status: 'completed', version: 4, inputHash: 'old' } };
  const normalized = normalizeCueRefinement(cue);
  assert.equal(normalized.status, 'pending');
  assert.equal(normalized.version, 1);
  assert.equal(normalized.inputHash, cueRefinementInputHash(cue));
});

test('refinement hash ignores null optional provenance but tracks authority changes', () => {
  const cue = { cueId: 'cue-1', sequence: 1, rawSource: 'source', rawTranslation: 'translation',
    initialTranslation: 'Initial', translationVersion: 1,
    translationProvenance: { audioTurnId: 'turn-1', turnKey: 'turn-1',
      providerEventId: null, eventId: null, connectionEpoch: 1, providerEpoch: 1, eventSequence: 4 } };
  const canonical = { ...cue, translationProvenance: { audioTurnId: 'turn-1', turnKey: 'turn-1',
    connectionEpoch: 1, providerEpoch: 1, eventSequence: 4 } };
  assert.equal(cueRefinementInputHash(cue), cueRefinementInputHash(canonical));
  assert.notEqual(cueRefinementInputHash({ ...canonical, translationVersion: 2 }), cueRefinementInputHash(canonical));
  assert.notEqual(cueRefinementInputHash({ ...canonical, translationProvenance: {
    ...canonical.translationProvenance, eventSequence: 5
  } }), cueRefinementInputHash(canonical));
});
