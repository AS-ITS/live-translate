import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMeetingSummarySource } from '../../src/application/meetingSummarySource.js';

const cue = (cueId, sourceText, sequence = 1) => ({ cueId, sourceText, sequence, startTimeMs: sequence * 100, endTimeMs: sequence * 100 + 50 });

test('builds a deterministic final Cue source and excludes internal metadata', () => {
  const input = { cues: [cue('b', 'second', 2), cue('a', 'first'), cue('a', 'first'), cue('x', '!!!', 3)] };
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
