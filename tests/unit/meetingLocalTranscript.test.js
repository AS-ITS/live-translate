import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mergeMeetingDetailWithLocalCues
} from '../../src/lib/meetingLocalTranscript.js';
import { exportCuesToTxt } from '../../src/lib/subtitleCueExport.js';

const cue = (overrides = {}) => ({
  cueId: 'cue-1',
  sessionId: 'recording-1',
  segmentId: 'segment-1',
  sequence: 1,
  startTimeMs: 0,
  endTimeMs: 1_000,
  sourceText: '第一句原文',
  translatedText: 'First translation',
  sourceVersion: 1,
  translationVersion: 1,
  sourceLanguageCode: 'zh-Hant',
  targetLanguageCode: 'en',
  status: 'final',
  finalizedReason: 'stop',
  ...overrides
});
const localRecord = (value, overrides = {}) => ({
  meetingId: 'meeting-1',
  sessionId: value.sessionId,
  segmentId: value.segmentId,
  cueId: value.cueId,
  sequence: value.sequence,
  cue: value,
  producedAt: value.finalizedAt ?? 1_000,
  updatedAt: 1_000,
  ...overrides
});

test('B2 detail uses only committed Local Cues and does not fall back to cloud content', () => {
  const stale = cue({ sourceText: 'stale cloud', revision: 1 });
  const local = cue({ sourceText: 'committed local', revision: 2 });
  const detail = { ...emptyDetail(), cues: [stale] };
  const recovered = mergeMeetingDetailWithLocalCues(detail, [localRecord(local)], { authoritative: true });
  assert.deepEqual(recovered.cues, [local]);
  assert.deepEqual(recovered.readingContent.sourceTranscript.paragraphs, ['committed local']);
  const empty = mergeMeetingDetailWithLocalCues(detail, [], { authoritative: true });
  assert.deepEqual(empty.cues, []);
  assert.deepEqual(empty.readingContent.sourceTranscript.paragraphs, []);
});

const emptyDetail = () => ({
  meeting: {
    id: 'meeting-1',
    status: 'completed',
    startedAt: 0,
    endedAt: 5_000,
    transcriptSummary: {
      totalItems: 0,
      sourceFinalCount: 0,
      translationFinalCount: 0,
      hasTranscript: false
    }
  },
  segments: [{ id: 'segment-1', sequence: 1 }],
  transcriptItems: [],
  cues: [],
  readingContent: {
    sourceTranscript: { kind: 'sourceTranscript', status: 'empty', text: '', paragraphs: [] },
    translationArticle: { kind: 'translationArticle', status: 'empty', text: '', paragraphs: [] }
  }
});

test('restores a stopped meeting from local cues and exports source, translation, or both', () => {
  const records = [
    localRecord(cue()),
    localRecord(cue({
      cueId: 'cue-2',
      sequence: 2,
      startTimeMs: 1_000,
      endTimeMs: 2_000,
      sourceText: '最後一句原文',
      translatedText: 'Last translation'
    })),
    localRecord(cue({
      cueId: 'cue-3',
      sequence: 3,
      startTimeMs: 2_000,
      endTimeMs: 3_000,
      sourceText: '僅原文',
      translatedText: '',
      translationVersion: 0
    })),
    localRecord(cue({
      cueId: 'cue-4',
      sequence: 4,
      startTimeMs: 3_000,
      endTimeMs: 4_000,
      sourceText: '',
      translatedText: 'Translation only',
      sourceVersion: 0
    }))
  ];

  const detail = mergeMeetingDetailWithLocalCues(emptyDetail(), records);

  assert.deepEqual(detail.readingContent.sourceTranscript.paragraphs, [
    '第一句原文',
    '最後一句原文',
    '僅原文'
  ]);
  assert.deepEqual(detail.readingContent.translationArticle.paragraphs, [
    'First translation',
    'Last translation',
    'Translation only'
  ]);
  assert.deepEqual(detail.meeting.transcriptSummary, {
    totalItems: 6,
    sourceFinalCount: 3,
    translationFinalCount: 3,
    hasTranscript: true
  });
  assert.equal(detail.localTranscriptStatus, 'recovered');
  assert.equal(exportCuesToTxt(detail.cues, { stream: 'source' }), '第一句原文\n最後一句原文\n僅原文\n');
  assert.equal(exportCuesToTxt(detail.cues, { stream: 'translation' }), 'First translation\nLast translation\nTranslation only\n');
  assert.equal(exportCuesToTxt(detail.cues, { stream: 'both' }), 'Source\n第一句原文\n最後一句原文\n僅原文\n\nTranslation\nFirst translation\nLast translation\nTranslation only\n');
});

test('late text updates the same cue instead of duplicating it', () => {
  const sourceOnly = cue({ translatedText: '', translationVersion: 0 });
  const withLateTranslation = cue({ translatedText: 'Late translation', translationVersion: 1 });
  const detail = mergeMeetingDetailWithLocalCues(emptyDetail(), [
    localRecord(sourceOnly, { updatedAt: 1_000 }),
    localRecord(withLateTranslation, { updatedAt: 2_000 })
  ]);

  assert.equal(detail.cues.length, 1);
  assert.equal(detail.cues[0].sourceText, '第一句原文');
  assert.equal(detail.cues[0].translatedText, 'Late translation');
});
