import assert from 'node:assert/strict';
import test from 'node:test';
import {
  exportCuesToSrt,
  exportCuesToTxt,
  exportCuesToVtt,
  formatSrtTimestamp,
  formatVttTimestamp,
  normalizeCueTimeline,
  normalizeExportableCues,
  wrapSubtitleText
} from '../../src/lib/subtitleCueExport.js';

const cue = (overrides = {}) => ({
  cueId: 'cue-1',
  sessionId: 'session-1',
  segmentId: 'segment-1',
  sequence: 1,
  startTimeMs: 1200,
  endTimeMs: 4800,
  sourceLanguageCode: 'en',
  targetLanguageCode: 'zh-Hant',
  sourceText: 'Hello source.',
  translatedText: '你好翻譯。',
  status: 'final',
  finalizedReason: 'final',
  ...overrides
});

test('formats SRT and VTT timestamps including hours', () => {
  assert.equal(formatSrtTimestamp(3_723_456), '01:02:03,456');
  assert.equal(formatVttTimestamp(3_723_456), '01:02:03.456');
});

test('filters partial, blank, and punctuation-only cues and sorts by sequence', () => {
  const result = normalizeExportableCues([
    cue({ cueId: 'cue-2', sequence: 2, translatedText: 'second' }),
    cue({ cueId: 'partial', sequence: 3, status: 'partial', translatedText: 'draft' }),
    cue({ cueId: 'blank', sequence: 4, translatedText: '   ' }),
    cue({ cueId: 'punctuation', sequence: 5, translatedText: '？！' }),
    cue({ cueId: 'cue-1', sequence: 1, translatedText: 'first' })
  ], { stream: 'translation' });

  assert.deepEqual(result.map((item) => item.cueId), ['cue-1', 'cue-2']);
});

test('deduplicates identical cue ids and rejects sequence conflicts', () => {
  assert.equal(normalizeExportableCues([cue(), cue()], { stream: 'translation' }).length, 1);
  assert.throws(
    () => normalizeExportableCues([cue(), cue({ cueId: 'cue-2' })], { stream: 'translation' }),
    /sequence 1 is shared/
  );
  assert.throws(
    () => normalizeExportableCues([cue(), cue({ translatedText: 'changed' })], { stream: 'translation' }),
    /conflicting payload/
  );
});

test('normalizes a small overlap without mutating input', () => {
  const input = [cue({ endTimeMs: 2000 }), cue({ cueId: 'cue-2', sequence: 2, startTimeMs: 1900, endTimeMs: 3000 })];
  const before = JSON.stringify(input);
  const result = normalizeCueTimeline(input, { overlapToleranceMs: 200 });
  assert.equal(result[1].startTimeMs, 2001);
  assert.equal(JSON.stringify(input), before);
});

test('rejects invalid and severe timelines', () => {
  assert.throws(() => normalizeCueTimeline([cue({ startTimeMs: -1 })]), /invalid timeline/);
  assert.throws(() => normalizeCueTimeline([cue({ endTimeMs: 2000 }), cue({ cueId: 'cue-2', sequence: 2, startTimeMs: 0, endTimeMs: 50 })]), /overlaps/);
});

test('wraps language-aware subtitle lines without splitting protected tokens', () => {
  const wrapped = wrapSubtitleText('Visit https://example.com/path and email test@example.com on 2026-08-04 at 12.50 kg.', 'en', { maxChars: 30 });
  const lines = wrapped.split('\n');
  assert.ok(lines.length <= 2);
  assert.ok(wrapped.includes('https://example.com/path'));
  assert.ok(wrapped.includes('test@example.com'));
  assert.ok(wrapped.includes('2026-08-04'));
  assert.ok(wrapped.includes('12.50 kg'));
});

test('exports Cue TXT in sequence order and preserves source/translation pairing', () => {
  const cues = [
    cue({ cueId: 'cue-2', sequence: 2, startTimeMs: 5000, endTimeMs: 6000, sourceText: 'source two', translatedText: 'translation two' }),
    cue({ cueId: 'cue-1', sequence: 1, sourceText: 'source one', translatedText: 'translation one' })
  ];
  assert.equal(exportCuesToTxt(cues, { stream: 'translation' }), 'translation one\ntranslation two\n');
  assert.equal(exportCuesToTxt(cues, { stream: 'both' }), 'Source\nsource one\nsource two\n\nTranslation\ntranslation one\ntranslation two\n');
});

test('exports SRT blocks and VTT header from session-relative Cue time', () => {
  const cues = [cue()];
  assert.equal(exportCuesToSrt(cues, { stream: 'translation' }), '1\n00:00:01,200 --> 00:00:04,800\n你好翻譯。\n');
  assert.equal(exportCuesToVtt(cues, { stream: 'source' }), 'WEBVTT\n\n00:00:01.200 --> 00:00:04.800\nHello source.\n');
});
