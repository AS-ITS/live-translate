import assert from 'node:assert/strict';
import test from 'node:test';
import { createMeetingSummaryJobQueue } from '../../src/application/meetingSummaryJobQueue.js';
import { createMeetingSummaryJobEnqueuer } from '../../src/application/meetingSummaryJobEnqueuer.js';
import { createMeetingSummaryRecovery } from '../../src/application/meetingSummaryRecovery.js';
import { createMeetingSummaryRetryErrorClassifier, createMeetingSummaryRetryPolicy } from '../../src/application/meetingSummaryRetryPolicy.js';
import { createMeetingSummaryWorker } from '../../src/application/meetingSummaryWorker.js';
import { createMemoryMeetingSummaryJobRepository } from '../../src/infrastructure/meetingSummaryJobRepositoryAdapter.js';

const NOW = '2026-08-04T00:00:00.000Z';

test('enqueue is idempotent and permits at most one active job per session', async () => {
  const repository = createMemoryMeetingSummaryJobRepository();
  const queue = createMeetingSummaryJobQueue();
  const enqueuer = createMeetingSummaryJobEnqueuer({
    jobRepository: repository,
    activeQueue: queue,
    idGenerator: (() => { let id = 0; return () => `job-${++id}`; })(),
    clock: () => NOW
  });

  const first = await enqueuer.enqueue({ sessionId: 'session-1', meetingId: 'meeting-1' });
  const second = await enqueuer.enqueue({ sessionId: 'session-1', meetingId: 'meeting-1' });

  assert.equal(first.jobId, second.jobId);
  assert.equal(queue.size(), 1);
  assert.equal((await repository.list()).length, 1);
});

test('worker claims and persists a completed terminal job without blocking enqueue', async () => {
  const repository = createMemoryMeetingSummaryJobRepository();
  const queue = createMeetingSummaryJobQueue();
  await repository.enqueue({ jobId: 'job-1', sessionId: 'session-1', meetingId: 'meeting-1', enqueuedAt: NOW });
  await queue.enqueue({ jobId: 'job-1', sessionId: 'session-1', meetingId: 'meeting-1' });
  const worker = createWorker({ repository, queue, generateAndPersist: async () => ({ summaryId: 'summary-1' }) });

  const result = await worker.processNext();
  const job = await repository.get('job-1');

  assert.equal(result.status, 'completed');
  assert.equal(job.status, 'completed');
  assert.equal(job.attempt, 1);
  assert.equal(job.fenceToken, 1);
});

test('retryable failures use exponential backoff and exhausted jobs fail', async () => {
  const repository = createMemoryMeetingSummaryJobRepository();
  const queue = createMeetingSummaryJobQueue();
  let calls = 0;
  await repository.enqueue({ jobId: 'job-1', sessionId: 'session-1', meetingId: 'meeting-1', enqueuedAt: NOW });
  await queue.enqueue({ jobId: 'job-1', sessionId: 'session-1', meetingId: 'meeting-1' });
  const worker = createWorker({
    repository,
    queue,
    generateAndPersist: async () => { calls += 1; const error = new Error('temporary'); error.retryable = true; throw error; },
    maxAttempts: 3,
    baseDelayMs: 100
  });

  await worker.processNext();
  let job = await repository.get('job-1');
  assert.equal(job.status, 'queued');
  assert.equal(job.availableAt, '2026-08-04T00:00:00.100Z');
  await queue.enqueue({ jobId: job.jobId, sessionId: job.sessionId, meetingId: job.meetingId });
  await worker.processNext();
  job = await repository.get('job-1');
  assert.equal(job.availableAt, '2026-08-04T00:00:00.200Z');
  await queue.enqueue({ jobId: job.jobId, sessionId: job.sessionId, meetingId: job.meetingId });
  await worker.processNext();
  job = await repository.get('job-1');
  assert.equal(job.status, 'failed');
  assert.equal(calls, 3);
});

test('non-retryable failures persist failed state immediately', async () => {
  const repository = createMemoryMeetingSummaryJobRepository();
  const queue = createMeetingSummaryJobQueue();
  await repository.enqueue({ jobId: 'job-1', sessionId: 'session-1', meetingId: 'meeting-1', enqueuedAt: NOW });
  await queue.enqueue({ jobId: 'job-1', sessionId: 'session-1', meetingId: 'meeting-1' });
  const worker = createWorker({ repository, queue, generateAndPersist: async () => { throw new TypeError('invalid summary'); } });

  await worker.processNext();

  const job = await repository.get('job-1');
  assert.equal(job.status, 'failed');
  assert.equal(job.failureInfo.reason, 'validation_or_domain_error');
});

test('startup recovery reclaims expired processing jobs and ignores completed jobs', async () => {
  const repository = createMemoryMeetingSummaryJobRepository();
  const queue = createMeetingSummaryJobQueue();
  await repository.enqueue({ jobId: 'expired', sessionId: 'session-1', meetingId: 'meeting-1', enqueuedAt: NOW });
  await repository.claim('expired', { leaseId: 'lease-1', claimedAt: '2026-08-03T23:00:00.000Z', leaseExpiresAt: '2026-08-03T23:30:00.000Z' });
  await repository.enqueue({ jobId: 'done', sessionId: 'session-2', meetingId: 'meeting-2', enqueuedAt: NOW });
  const done = await repository.claim('done', { leaseId: 'lease-2', claimedAt: NOW, leaseExpiresAt: '2026-08-04T01:00:00.000Z' });
  await repository.complete('done', { leaseId: done.leaseId, fenceToken: done.fenceToken }, NOW);
  const recovery = createMeetingSummaryRecovery({ jobRepository: repository, activeQueue: queue, clock: () => NOW });

  assert.equal(await recovery.recover(), 1);
  assert.equal(queue.size(), 1);
  assert.equal((await repository.get('expired')).status, 'queued');
  assert.equal((await repository.get('done')).status, 'completed');
});

function createWorker({ repository, queue, generateAndPersist, maxAttempts = 3, baseDelayMs = 100 } = {}) {
  return createMeetingSummaryWorker({
    activeQueue: queue,
    jobRepository: repository,
    summaryPersistenceService: { generateAndPersist },
    retryPolicy: createMeetingSummaryRetryPolicy({ maxAttempts, baseDelayMs, maxDelayMs: 1000 }),
    retryErrorClassifier: createMeetingSummaryRetryErrorClassifier(),
    clock: () => NOW,
    leaseIdFactory: (() => { let id = 0; return () => `lease-${++id}`; })()
  });
}
