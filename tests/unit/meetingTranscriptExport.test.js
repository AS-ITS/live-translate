import assert from 'node:assert/strict';
import test from 'node:test';
import { hasCompleteFinalCues, meetingExportSources } from '../../src/lib/meetingTranscriptExport.js';

function detail({ cues = [], chunks = [] } = {}) {
  return {
    transcriptItems: chunks.map((chunk, index) => ({ ...chunk, id: `item-${index}` })),
    cues,
    segments: [{
      id: 'segment-1',
      checkpoint: { durableChunks: chunks }
    }]
  };
}

function cue(overrides = {}) {
  return {
    cueId: 'cue-1',
    segmentId: 'segment-1',
    status: 'final',
    sourceText: '原文一',
    translatedText: 'translation one',
    ...overrides
  };
}

const chunks = [
  { stream: 'source', text: '原文一' },
  { stream: 'translation', text: 'translation one' }
];

test('TXT uses all durable transcript items when Cues are partial', () => {
  const meeting = detail({
    chunks: [...chunks, { stream: 'source', text: '原文二' }, { stream: 'translation', text: 'translation two' }],
    cues: [cue()]
  });

  assert.equal(hasCompleteFinalCues(meeting), false);
  assert.deepEqual(meetingExportSources(meeting, 'txt'), { items: meeting.transcriptItems, cues: [] });
});

test('timed export uses complete Cues', () => {
  const meeting = detail({ cues: [cue()] , chunks });

  assert.equal(hasCompleteFinalCues(meeting), true);
  assert.deepEqual(meetingExportSources(meeting, 'srt'), { items: meeting.transcriptItems, cues: meeting.cues });
});

test('timed export falls back when a Cue omits a durable chunk', () => {
  const meeting = detail({
    chunks: [...chunks, { stream: 'source', text: '原文二' }, { stream: 'translation', text: 'translation two' }],
    cues: [cue()]
  });

  assert.deepEqual(meetingExportSources(meeting, 'vtt').cues, []);
});
