import { randomUUID } from 'node:crypto';
import { assertMeetingSummaryJobRepository } from '../domain/meetingSummaryJob/meetingSummaryJobRepository.js';

const IDLE = Object.freeze({ status: 'idle' });

export function createMeetingSummaryWorker({ activeQueue, jobRepository, summaryPersistenceService, retryPolicy, retryErrorClassifier, clock = () => new Date().toISOString(), leaseDurationMs = 300000, leaseIdFactory = randomUUID } = {}) {
  if (!activeQueue || typeof activeQueue.dequeue !== 'function') throw new TypeError('activeQueue.dequeue is required.');
  assertMeetingSummaryJobRepository(jobRepository);
  if (!summaryPersistenceService || typeof summaryPersistenceService.generateAndPersist !== 'function') throw new TypeError('summaryPersistenceService.generateAndPersist is required.');
  if (!retryPolicy || typeof retryPolicy.canRetry !== 'function' || typeof retryPolicy.getNextDelayMs !== 'function') throw new TypeError('retryPolicy is required.');
  if (!retryErrorClassifier || typeof retryErrorClassifier.classify !== 'function') throw new TypeError('retryErrorClassifier is required.');
  if (typeof clock !== 'function' || !Number.isInteger(leaseDurationMs) || leaseDurationMs <= 0 || typeof leaseIdFactory !== 'function') throw new TypeError('summary worker lease configuration is invalid.');

  return Object.freeze({
    async processNext() {
      const queuedJob = await activeQueue.dequeue();
      if (!queuedJob) return IDLE;
      let job = await jobRepository.get(queuedJob.jobId);
      if (!job || job.status !== 'queued') return { status: 'skipped', jobId: queuedJob.jobId };
      const now = clock();
      const claim = { leaseId: leaseIdFactory(), claimedAt: now, leaseExpiresAt: addMs(now, leaseDurationMs) };
      job = await jobRepository.claim(job.jobId, claim);
      const ownership = { leaseId: job.leaseId, fenceToken: job.fenceToken };

      try {
        const generate = job.kind === 'partial' && typeof summaryPersistenceService.generatePartialAndPersist === 'function'
          ? summaryPersistenceService.generatePartialAndPersist.bind(summaryPersistenceService)
          : job.kind === 'final' && typeof summaryPersistenceService.generateFinalAndPersist === 'function'
            ? summaryPersistenceService.generateFinalAndPersist.bind(summaryPersistenceService)
            : summaryPersistenceService.generateAndPersist.bind(summaryPersistenceService);
        const result = await generate({ sessionId: job.sessionId, meetingId: job.meetingId, range: job.range });
        await jobRepository.complete(job.jobId, ownership, clock());
        return { status: 'completed', jobId: job.jobId, summaryId: result?.summaryId };
      } catch (error) {
        const classification = retryErrorClassifier.classify(error);
        if (classification.retryable && retryPolicy.canRetry(job.attempt)) {
          const delayMs = retryPolicy.getNextDelayMs(job.attempt);
          const availableAt = addMs(clock(), delayMs);
          await jobRepository.retry(job.jobId, ownership, {
            availableAt,
            failureInfo: failureInfo(error, classification.reason)
          });
          return { status: 'retrying', jobId: job.jobId, attempt: job.attempt, availableAt };
        }
        await jobRepository.fail(job.jobId, ownership, { failedAt: clock(), failureInfo: failureInfo(error, classification.reason) });
        return { status: 'failed', jobId: job.jobId, attempt: job.attempt };
      }
    }
  });
}

function addMs(timestamp, delayMs) { return new Date(new Date(timestamp).getTime() + delayMs).toISOString(); }
function failureInfo(error, reason) { return { reason, name: error?.name || 'Error', message: typeof error?.message === 'string' ? error.message : 'Summary generation failed.' }; }
