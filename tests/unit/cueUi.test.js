import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cueListForDisplay,
  distanceFromScrollBottom,
  formatCueTimecode,
  partialCueForDisplay,
  shouldFollowLatest,
  sourceTextForDisplay,
  sourceTextForCopy,
  sortFinalCues,
  translationTextForCopy,
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

test('source text for copy includes only completed source cues in sequence order', () => {
  assert.equal(sourceTextForCopy([
    finalCue('cue-2', 2, '  第二段原文  '),
    { ...finalCue('partial', 3, '不應複製'), status: 'partial' },
    finalCue('cue-1', 1, '第一段原文'),
    { ...finalCue('cue-empty', 4, '   '), translatedText: 'translation only' }
  ]), '第一段原文\n第二段原文');
});

test('source display keeps raw source when a refined source exists', () => {
  assert.equal(sourceTextForDisplay({
    sourceLanguageCode: 'en',
    sourceText: 'raw source',
    rawSource: 'raw source',
    refinedSource: 'refined source'
  }), 'raw source');
});

test('source display and source copy use the same raw original', () => {
  const cue = {
    cueId: 'raw-copy',
    sequence: 1,
    status: 'final',
    sourceText: 'refined source',
    rawSource: 'raw source',
    refinedSource: 'refined source'
  };
  assert.equal(sourceTextForDisplay(cue), sourceTextForCopy([cue]));
  assert.equal(sourceTextForCopy([cue]), 'raw source');
});

test('translation text for copy includes only completed translation cues in sequence order', () => {
  assert.equal(translationTextForCopy([
    finalCue('cue-2', 2, 'source 2'),
    { ...finalCue('partial', 3, 'source 3'), status: 'partial', translatedText: '不應複製' },
    { ...finalCue('cue-1', 1, 'source 1'), translatedText: '第一段翻譯' },
    { ...finalCue('cue-empty', 4, 'source 4'), translatedText: '   ' }
  ]), '第一段翻譯\ntranslation 2');
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

test('live display keeps raw cues that are not included in refined subtitle results', () => {
  const rawCues = [
    { ...finalCue('cue-1', 1), sessionId: 'session-1', segmentId: 'segment-1' },
    { ...finalCue('cue-2', 2), sessionId: 'session-1', segmentId: 'segment-1' },
    { ...finalCue('cue-3', 3), sessionId: 'session-1', segmentId: 'segment-1' }
  ];
  const refined = [{
    ...rawCues[0],
    sourceText: '修正版原文',
    translatedText: 'refined translation'
  }];

  const display = cueListForDisplay({ finalCues: rawCues, refinedSubtitleCues: refined }, { includePartial: false });

  assert.deepEqual(display.map((cue) => cue.cueId), ['cue-1', 'cue-2', 'cue-3']);
  assert.equal(display[0].sourceText, '修正版原文');
  assert.equal(display[1].sourceText, rawCues[1].sourceText);
});

test('live display hides an unpaired translation partial without source text', () => {
  assert.deepEqual(cueListForDisplay({
    finalCues: [],
    currentCue: { cueId: 'translation-only', status: 'partial', translatedText: 'translation only' }
  }, { requireSourceTextForPartial: true }), []);
});

test('live display includes a translation-only partial by default', () => {
  const display = cueListForDisplay({
    finalCues: [],
    currentCue: { cueId: 'translation-only', status: 'partial', translatedText: 'translation only' }
  });

  assert.equal(display.length, 1);
  assert.equal(display[0].translatedText, 'translation only');
});

test('live display keeps completed cues as separate sentence rows', () => {
  const first = {
    ...finalCue('cue-1', 1, '123'),
    sessionId: 'session-1',
    segmentId: 'segment-1',
    translatedText: '1, 2, 3'
  };
  const second = {
    cueId: 'cue-2',
    sequence: 2,
    status: 'partial',
    sessionId: 'session-1',
    segmentId: 'segment-1',
    sourceText: '123',
    translatedText: '1, 2, 3, 1, 2',
    startTimeMs: 2100,
    endTimeMs: 2200,
    updatedTimeMs: 2200
  };

  const display = cueListForDisplay({ finalCues: [first], currentCue: second });

  assert.equal(display.length, 2);
  assert.equal(display[0].sourceText, '123');
  assert.equal(display[1].sourceText, '123');
  assert.equal(display[1].translatedText, '1, 2, 3, 1, 2');
  assert.equal(display[1].status, 'partial');
});

test('live display converts Chinese source text to Traditional Chinese by default', () => {
  const display = cueListForDisplay({ finalCues: [{
    ...finalCue('cue-hant', 1, '测试文字'),
    sourceLanguageCode: 'zh-Hant'
  }]}, { includePartial: false });

  assert.equal(display[0].sourceText, '測試文字');
});

test('live display preserves Simplified Chinese when explicitly selected', () => {
  const display = cueListForDisplay({ finalCues: [{
    ...finalCue('cue-hans', 1, '测试文字'),
    sourceLanguageCode: 'zh-Hans'
  }]}, { includePartial: false });

  assert.equal(display[0].sourceText, '测试文字');
});

test('history display keeps repeated cues as separate persisted records', () => {
  const first = { ...finalCue('cue-1', 1, '123'), sessionId: 'session-1', segmentId: 'segment-1' };
  const second = { ...finalCue('cue-2', 2, '123'), sessionId: 'session-1', segmentId: 'segment-1' };

  assert.deepEqual(cueListForDisplay({ finalCues: [first, second] }, { includePartial: false }).map((cue) => cue.cueId), ['cue-1', 'cue-2']);
});

test('export display merges identical adjacent finalized cues and keeps the full timeline', () => {
  const first = { ...finalCue('cue-1', 1, 'same'), sessionId: 'session-1', segmentId: 'segment-1', startTimeMs: 1000, endTimeMs: 1800 };
  const second = { ...finalCue('cue-2', 2, 'same'), translatedText: 'translation 1', sessionId: 'session-1', segmentId: 'segment-1', startTimeMs: 1800, endTimeMs: 2600 };

  const display = cueListForDisplay({ finalCues: [first, second] }, { includePartial: false, mergeRepeatedFinalCues: true });

  assert.equal(display.length, 1);
  assert.equal(display[0].cueId, 'cue-1');
  assert.equal(display[0].startTimeMs, 1000);
  assert.equal(display[0].endTimeMs, 2600);
});

test('export display does not merge cumulative repeated finalized cues with different text', () => {
  const first = { ...finalCue('cue-1', 1, '123'), sessionId: 'session-1', segmentId: 'segment-1', translatedText: '1, 2, 3' };
  const second = { ...finalCue('cue-2', 2, '123'), sessionId: 'session-1', segmentId: 'segment-1', translatedText: '1, 2, 3, 1, 2' };

  assert.equal(cueListForDisplay({ finalCues: [first, second] }, { includePartial: false, mergeRepeatedFinalCues: true }).length, 2);
});

test('follow-latest uses distance from the scroll bottom threshold', () => {
  const element = { scrollHeight: 1000, scrollTop: 820, clientHeight: 100 };
  assert.equal(distanceFromScrollBottom(element), 80);
  assert.equal(shouldFollowLatest(element), true);
  assert.equal(shouldFollowLatest({ ...element, scrollTop: 700 }), false);
});
