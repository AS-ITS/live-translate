import assert from 'node:assert/strict';
import test from 'node:test';
import { createMeetingSummaryService } from '../../src/application/meetingSummaryService.js';
import { createMeetingSummaryPersistenceService } from '../../src/application/meetingSummaryPersistenceService.js';
import { createMeetingSummaryJobEnqueuer } from '../../src/application/meetingSummaryJobEnqueuer.js';
import { createMemoryMeetingSummaryRepository } from '../../src/infrastructure/meetingSummaryRepositoryAdapter.js';
import { createMemoryMeetingSummaryJobRepository } from '../../src/infrastructure/meetingSummaryJobRepositoryAdapter.js';
import { createMeetingSummaryJobQueue } from '../../src/application/meetingSummaryJobQueue.js';
import { createMeetingSummaryWorker } from '../../src/application/meetingSummaryWorker.js';
import { createMeetingSummaryRetryPolicy, createMeetingSummaryRetryErrorClassifier } from '../../src/application/meetingSummaryRetryPolicy.js';

const cue = (segmentSequence, sequence, text) => ({
  cueId: `cue-${segmentSequence}-${sequence}`, sessionId: 'session-1', segmentId: `segment-${segmentSequence}`,
  segmentSequence, sequence, startTimeMs: sequence * 100, endTimeMs: sequence * 100 + 50,
  sourceText: text, translatedText: `translated ${text}`, status: 'final'
});

function setup({ provider } = {}) {
  const finalCueRepository = { async listFinalCuesByMeeting() { return [cue(1, 1, 'later'), cue(0, 1, 'first')]; } };
  const summaryService = createMeetingSummaryService({
    finalCueRepository,
    summaryProvider: provider || { async summarizeChunk({ cues }) { return { title: 'Meeting', overview: cues.map((item) => item.sourceText).join(' '), keyPoints: cues.map((item) => item.sourceText), decisions: [], actionItems: [] }; } }
  });
  let id = 0;
  const summaryRepository = createMemoryMeetingSummaryRepository();
  const persistence = createMeetingSummaryPersistenceService({
    summaryRepository, summaryService,
    sessionRepository: { async getSessionRecord() { return { sessionRecord: { id: 'session-1' } }; } },
    model: 'model', idGenerator: () => `summary-${++id}`, clock: (() => { let now = 0; return () => ++now; })()
  });
  return { summaryService, summaryRepository, persistence };
}

test('persists distinct partial summaries and final merge preserves segment chronology', async () => {
  const { summaryService, summaryRepository, persistence } = setup();
  const ranges = await summaryService.listFinalCueRanges({ sessionId: 'session-1', meetingId: 'meeting-1' });
  assert.deepEqual(ranges.map((range) => range.segmentSequence), [0, 1]);
  await persistence.generatePartialAndPersist({ sessionId: 'session-1', meetingId: 'meeting-1', range: ranges[1] });
  await persistence.generatePartialAndPersist({ sessionId: 'session-1', meetingId: 'meeting-1', range: ranges[0] });
  const final = await persistence.generateFinalAndPersist({ sessionId: 'session-1', meetingId: 'meeting-1' });
  const repeated = await persistence.generateFinalAndPersist({ sessionId: 'session-1', meetingId: 'meeting-1' });
  assert.equal(final.kind, 'final');
  assert.equal(final.summary.overview, 'first\n\nlater');
  assert.equal(repeated.summaryId, final.summaryId);
  assert.equal((await summaryRepository.listPartialSummariesBySessionId('session-1')).length, 2);
  assert.equal((await summaryRepository.getSummaryBySessionId('session-1')).summaryId, final.summaryId);
});

test('partial retry retains the failed attempt and does not overwrite a completed range', async () => {
  let fail = true;
  const { summaryService, summaryRepository, persistence } = setup({ provider: { async summarizeChunk() { if (fail) { fail = false; throw new Error('temporary'); } return { title: 'T', overview: 'ok', keyPoints: [], decisions: [], actionItems: [] }; } } });
  const [range] = await summaryService.listFinalCueRanges({ sessionId: 'session-1', meetingId: 'meeting-1' });
  await assert.rejects(persistence.generatePartialAndPersist({ sessionId: 'session-1', meetingId: 'meeting-1', range }), /temporary/);
  const completed = await persistence.generatePartialAndPersist({ sessionId: 'session-1', meetingId: 'meeting-1', range });
  const again = await persistence.generatePartialAndPersist({ sessionId: 'session-1', meetingId: 'meeting-1', range });
  assert.equal(again.summaryId, completed.summaryId);
  assert.deepEqual((await summaryRepository.listPartialSummariesBySessionId('session-1')).map((item) => item.status).sort(), ['completed', 'failed']);
});

test('partial jobs are idempotent by range while final job has a separate stable key', async () => {
  const repository = createMemoryMeetingSummaryJobRepository();
  const queue = createMeetingSummaryJobQueue();
  const enqueuer = createMeetingSummaryJobEnqueuer({ repository, jobRepository: repository, activeQueue: queue, idGenerator: (() => { let id = 0; return () => `job-${++id}`; })() });
  const range = { segmentId: 'segment-0', segmentSequence: 0, startCueId: 'cue-0-1', endCueId: 'cue-0-1', rangeKey: '0:segment-0:cue-0-1:cue-0-1' };
  const first = await enqueuer.enqueuePartial({ sessionId: 'session-1', meetingId: 'meeting-1', range });
  const duplicate = await enqueuer.enqueuePartial({ sessionId: 'session-1', meetingId: 'meeting-1', range });
  const final = await enqueuer.enqueue({ sessionId: 'session-1', meetingId: 'meeting-1' });
  assert.equal(first.jobId, duplicate.jobId);
  assert.notEqual(first.jobId, final.jobId);
  assert.equal(queue.size(), 2);
});

test('final merge refuses missing partial ranges and remains idempotent after completion', async () => {
  const { summaryService, persistence } = setup();
  const [range] = await summaryService.listFinalCueRanges({ sessionId: 'session-1', meetingId: 'meeting-1' });
  await persistence.generatePartialAndPersist({ sessionId: 'session-1', meetingId: 'meeting-1', range });
  await assert.rejects(persistence.generateFinalAndPersist({ sessionId: 'session-1', meetingId: 'meeting-1' }), { code: 'meeting_summary_partials_pending' });
});

test('worker dispatches a partial job through the existing lease and retry path', async () => {
  const repository = createMemoryMeetingSummaryJobRepository();
  const queue = createMeetingSummaryJobQueue();
  const range = { segmentId: 'segment-0', segmentSequence: 0, startCueId: 'cue-0-1', endCueId: 'cue-0-1', rangeKey: '0:segment-0:cue-0-1:cue-0-1' };
  const job = await repository.enqueue({ jobId: 'partial-job', idempotencyKey: 'partial:session-1:range-1', kind: 'partial', range, sessionId: 'session-1', meetingId: 'meeting-1', enqueuedAt: '2026-08-04T00:00:00.000Z' });
  await queue.enqueue({ jobId: job.jobId, sessionId: job.sessionId, meetingId: job.meetingId });
  const calls = [];
  const worker = createMeetingSummaryWorker({
    activeQueue: queue, jobRepository: repository,
    summaryPersistenceService: { async generatePartialAndPersist(input) { calls.push(input); return { summaryId: 'partial-summary-1' }; }, async generateAndPersist() { throw new Error('wrong dispatch'); } },
    retryPolicy: createMeetingSummaryRetryPolicy({ maxAttempts: 1 }), retryErrorClassifier: createMeetingSummaryRetryErrorClassifier(),
    clock: () => '2026-08-04T00:00:00.000Z', leaseIdFactory: () => 'lease-1'
  });
  const result = await worker.processNext();
  assert.equal(result.status, 'completed');
  assert.deepEqual(calls[0].range, range);
  assert.equal((await repository.get('partial-job')).fenceToken, 1);
});
