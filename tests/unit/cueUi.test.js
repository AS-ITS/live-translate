import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cueListForDisplay,
  distanceFromScrollBottom,
  formatCueTimecode,
  partialCueForDisplay,
  shouldFollowLatest,
  sortFinalCues,
  upsertFinalCue
} from '../../src/lib/cueUi.js';

const finalCue = (cueId, sequence, sourceText = '原文') => ({
  cueId, sequence, status: 'final', startTimeMs: sequence * 1000, endTimeMs: sequence * 2000,
  sourceText, translatedText: `translation ${sequence}`
});

test('formatCueTimecode formats milliseconds, minutes, hours, and invalid values', () => {
  assert.equal(formatCueTimecode(0), '00:00.000');
  assert.equal(formatCueTimecode(61_234), '01:01.234');
  assert.equal(formatCueTimecode(3_723_456), '01:02:03.456');
  assert.equal(formatCueTimecode(Number.NaN), '--:--.---');
});

test('final cues sort by sequence and upsert by cueId without duplicates', () => {
  const first = finalCue('cue-1', 1);
  const second = finalCue('cue-2', 2);
  assert.deepEqual(sortFinalCues([second, first]).map((cue) => cue.cueId), ['cue-1', 'cue-2']);
  assert.deepEqual(upsertFinalCue([second, first], { ...first, sourceText: 'updated' }), [
    { ...first, sourceText: 'updated' }, second
  ]);
});

test('partial display merges pending pairing state into one trailing row', () => {
  const display = cueListForDisplay({
    finalCues: [finalCue('cue-1', 1)],
    currentCue: { cueId: 'partial-1', status: 'partial', sourceText: 'source', updatedTimeMs: 10 },
    pendingCues: [{ cueId: 'partial-2', status: 'partial', translatedText: 'translation', updatedTimeMs: 20 }]
  });
  assert.equal(display.length, 2);
  assert.equal(display.at(-1).status, 'partial');
  assert.equal(display.at(-1).sourceText, 'source');
  assert.equal(display.at(-1).translatedText, 'translation');
  assert.equal(partialCueForDisplay({ pendingCues: [{ status: 'partial', sourceText: '  ... ' }] }), null);
});

test('history display excludes partial cues', () => {
  assert.deepEqual(cueListForDisplay({
    finalCues: [finalCue('cue-1', 1)],
    currentCue: { cueId: 'partial', status: 'partial', sourceText: 'preview' }
  }, { includePartial: false }).map((cue) => cue.cueId), ['cue-1']);
});

test('follow-latest uses distance from the scroll bottom threshold', () => {
  const element = { scrollHeight: 1000, scrollTop: 820, clientHeight: 100 };
  assert.equal(distanceFromScrollBottom(element), 80);
  assert.equal(shouldFollowLatest(element), true);
  assert.equal(shouldFollowLatest({ ...element, scrollTop: 700 }), false);
});
