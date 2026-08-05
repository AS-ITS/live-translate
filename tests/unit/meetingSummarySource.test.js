import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMeetingSummarySource } from '../../src/application/meetingSummarySource.js';

const cue = (cueId, sourceText, sequence = 1) => ({ cueId, sourceText, sequence, startTimeMs: sequence * 100, endTimeMs: sequence * 100 + 50 });

test('builds a deterministic final Cue source and excludes internal metadata', () => {
  const input = { cues: [cue('b', 'second', 2), cue('a', 'first'), cue('a', 'first'), { ...cue('partial', 'partial cue', 3), status: 'partial' }, { ...cue('x', '!!!', 4), status: 'partial' }] };
  const first = buildMeetingSummarySource(input);
  const second = buildMeetingSummarySource(input);
  assert.equal(first.sourceType, 'final_cues');
  assert.equal(first.sourceCueCount, 2);
  assert.equal(first.sourceText, 'first\n\nsecond');
  assert.equal(first.sourceHash, second.sourceHash);
  assert.deepEqual(first.cues, [
    { sourceText: 'first', startTimeMs: 100, endTimeMs: 150 },
    { sourceText: 'second', startTimeMs: 200, endTimeMs: 250 }
  ]);
});

test('orders Cues by Segment and sequence before timestamps', () => {
  const source = buildMeetingSummarySource({ cues: [
    { cueId: 'segment-1-cue-2', segmentId: 'segment-1', segmentSequence: 1, sequence: 2, startTimeMs: 100, sourceText: 'segment one second' },
    { cueId: 'segment-0-cue-2', segmentId: 'segment-0', segmentSequence: 0, sequence: 2, startTimeMs: 900, sourceText: 'segment zero second' },
    { cueId: 'segment-1-cue-1', segmentId: 'segment-1', segmentSequence: 1, sequence: 1, startTimeMs: 900, sourceText: 'segment one first' },
    { cueId: 'segment-0-cue-1', segmentId: 'segment-0', segmentSequence: 0, sequence: 1, startTimeMs: 100, sourceText: 'segment zero first' }
  ] });

  assert.equal(source.sourceText, 'segment zero first\n\nsegment zero second\n\nsegment one first\n\nsegment one second');
});

test('uses legacy final source transcript only when final Cues are absent', () => {
  const source = buildMeetingSummarySource({ cues: [], transcriptItems: [
    { id: 'source-1', stream: 'source', status: 'final', text: 'legacy source', sequence: 1 },
    { id: 'translation-1', stream: 'translation', status: 'final', text: 'legacy translation', sequence: 2 },
    { id: 'partial-1', stream: 'source', status: 'partial', text: 'draft', sequence: 3 }
  ] });
  assert.equal(source.sourceType, 'legacy_transcript');
  assert.equal(source.sourceText, 'legacy source');
});

test('rejects conflicting duplicate Cue identities', () => {
  assert.throws(() => buildMeetingSummarySource({ cues: [cue('same', 'one'), cue('same', 'two')] }), { code: 'meeting_summary_source_conflict' });
});
