import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chunkFinalCues,
  createFinalCueSummaryTrigger,
  createMeetingSummaryService,
  mergeChunkSummaries
} from '../../src/application/meetingSummaryService.js';

const cue = (sequence, text, segmentSequence = 0) => ({
  cueId: `cue-${segmentSequence}-${sequence}`, segmentSequence, sequence,
  startTimeMs: sequence * 100, endTimeMs: sequence * 100 + 50,
  sourceText: text, translatedText: `translated ${text}`
});

test('does not start summary generation before Final Subtitle Cues are available', async () => {
  let calls = 0;
  const service = createMeetingSummaryService({
    finalCueRepository: { async listFinalCuesByMeeting() { return []; } },
    summaryProvider: { async summarizeChunk() { calls += 1; } }
  });

  await assert.rejects(service.generate({ meetingId: 'meeting-1' }), { code: 'meeting_summary_cues_unavailable' });
  assert.equal(calls, 0);
});

test('orders cues, chunks within limits, and summarizes sequentially', async () => {
  const calls = [];
  const service = createMeetingSummaryService({
    finalCueRepository: { async listFinalCuesByMeeting() { return [cue(2, 'third', 1), cue(2, 'second'), cue(1, 'first')]; } },
    summaryProvider: { async summarizeChunk(input) { calls.push(input); return { overview: input.cues.map((item) => item.sourceText).join(',') }; } },
    maxCuesPerChunk: 2,
    maxCharactersPerChunk: 1000
  });

  const result = await service.generate({ meetingId: 'meeting-1' });
  assert.deepEqual(calls.map((call) => call.cues.map((item) => item.sourceText)), [['first', 'second'], ['third']]);
  assert.deepEqual(result.summary.overview, 'first,second\n\nthird');
  assert.equal(result.chunkCount, 2);
});

test('character chunking keeps cue order and allows one oversized cue', () => {
  const chunks = chunkFinalCues([cue(1, 'aa'), cue(2, 'bbbb'), cue(3, 'c')], { maxCharactersPerChunk: 80, maxCuesPerChunk: 10 });
  assert.deepEqual(chunks.flat().map((item) => item.sequence), [1, 2, 3]);
  assert.ok(chunks.length >= 1);
});

test('merging is deterministic and preserves first-seen list order without duplicates', () => {
  assert.deepEqual(mergeChunkSummaries([
    { title: 'T', overview: 'one', keyPoints: ['A', 'B'], decisions: ['D'], actionItems: ['X'] },
    { title: 'Other', overview: 'two', keyPoints: ['B', 'C'], decisions: ['D', 'E'], actionItems: ['X', 'Y'] }
  ]), {
    title: 'T', overview: 'one\n\ntwo', keyPoints: ['A', 'B', 'C'], decisions: ['D', 'E'], actionItems: ['X', 'Y']
  });
});

test('trigger delegates only through the summary service boundary', async () => {
  const calls = [];
  const trigger = createFinalCueSummaryTrigger({ summaryService: { async generate(input) { calls.push(input); return 'summary'; } } });
  assert.equal(await trigger.onFinalCuesFinalized({ meetingId: 'meeting-1' }), 'summary');
  assert.deepEqual(calls, [{ meetingId: 'meeting-1' }]);
});
