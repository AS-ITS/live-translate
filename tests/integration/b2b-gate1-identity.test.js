import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeCuesById } from '../../src/lib/cueMerge.js';

test('Gate 1: Conflicting export content for one Cue identity blocks export', () => {
  const cue = {
    cueId: 'content-id', revision: 1, status: 'final', segmentId: null,
    sourceText: 'Source', translatedText: 'Translation',
    rawTranslation: 'Raw translation', refinedSource: 'Refined source'
  };

  for (const changedField of ['rawTranslation', 'refinedSource']) {
    assert.throws(
      () => mergeCuesById([cue], [{ ...cue, [changedField]: 'Conflicting content' }]),
      { code: 'subtitle_cue_conflict' },
      `${changedField} must not be silently merged`
    );
  }
});

test('Gate 1: Equivalent Cues should export once', () => {
  const cue = {
    cueId: 'id-1',
    status: 'final',
    sourceText: 'Hello',
    translatedText: 'Bonjour',
    revision: 1,
    segmentId: null,
    startTimeMs: 1000,
    endTimeMs: 2000,
  };

  const merged = mergeCuesById([cue], [cue]);
  assert.strictEqual(merged.length, 1, 'Equivalent cues should be deduplicated');
});

test('Gate 1: Conflicting Content blocks export', () => {
  const cueA = {
    cueId: 'id-1',
    status: 'final',
    sourceText: 'Hello',
    translatedText: 'Bonjour',
    revision: 1,
    segmentId: null,
  };
  const cueB = {
    cueId: 'id-1',
    status: 'final',
    sourceText: 'Hi',
    translatedText: 'Salut',
    revision: 1,
    segmentId: null,
  };

  assert.throws(() => mergeCuesById([cueA], [cueB]), { code: 'subtitle_cue_conflict' });
});

test('Gate 1: Different identities with same text should both be exported', () => {
  const cueA = { cueId: 'id-1', status: 'final', sourceText: 'Hello', translatedText: 'Bonjour' };
  const cueB = { cueId: 'id-2', status: 'final', sourceText: 'Hello', translatedText: 'Bonjour' };

  const merged = mergeCuesById([cueA], [cueB]);
  assert.strictEqual(merged.length, 2, 'Same text with different IDs should remain separate');
});

test('Gate 1: No Segment Ownership Invention', () => {
  const cue = { cueId: 'id-1', status: 'final', segmentId: null };
  const merged = mergeCuesById([], [cue]);
  assert.strictEqual(merged[0].segmentId, null, 'Should not invent segmentId');
});

test('Gate 1: Conflicting revision blocks export', () => {
  const cueA = { cueId: 'id-1', revision: 1, status: 'final' };
  const cueB = { cueId: 'id-1', revision: 2, status: 'final' };
  assert.throws(() => mergeCuesById([cueA], [cueB]), { code: 'subtitle_cue_conflict' });
});

test('Gate 1: Conflicting ownership blocks export', () => {
  const cue = { cueId: 'id-1', revision: 1, status: 'final', segmentId: null };
  assert.throws(() => mergeCuesById([cue], [{ ...cue, segmentId: 'segment-1' }]), { code: 'subtitle_cue_conflict' });
});
