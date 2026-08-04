export function createMeetingSummaryJobEnqueuer({ jobRepository, activeQueue, idGenerator, summaryService, clock = () => new Date().toISOString() } = {}) {
  if (!jobRepository || typeof jobRepository.enqueue !== 'function') throw new TypeError('jobRepository.enqueue is required.');
  if (!activeQueue || typeof activeQueue.enqueue !== 'function') throw new TypeError('activeQueue.enqueue is required.');
  if (typeof idGenerator !== 'function') throw new TypeError('idGenerator must be a function.');
  if (typeof clock !== 'function') throw new TypeError('clock must be a function.');
  return Object.freeze({
    async enqueue({ sessionId, meetingId } = {}) {
      return enqueueFinal({ sessionId, meetingId });
    },
    async enqueuePartial({ sessionId, meetingId, range } = {}) {
      if (!nonEmpty(sessionId) || !nonEmpty(meetingId)) throw new TypeError('sessionId and meetingId must be non-empty strings.');
      if (!range?.rangeKey) throw new TypeError('partial summary range is required.');
      const job = await jobRepository.enqueue({ jobId: idGenerator('meeting-summary-job'), idempotencyKey: `partial:${sessionId}:${range.rangeKey}`, kind: 'partial', range, sessionId, meetingId, status: 'queued', attempt: 0, fenceToken: 0, enqueuedAt: clock(), availableAt: null });
      if (job.status === 'queued') await activeQueue.enqueue({ jobId: job.jobId, sessionId: job.sessionId, meetingId: job.meetingId });
      return job;
    },
    async enqueueForSession({ sessionId, meetingId } = {}) {
      if (!summaryService || typeof summaryService.listFinalCueRanges !== 'function') throw new TypeError('summaryService.listFinalCueRanges is required.');
      const ranges = await summaryService.listFinalCueRanges({ sessionId, meetingId });
      for (const range of ranges) await this.enqueuePartial({ sessionId, meetingId, range });
      return enqueueFinal({ sessionId, meetingId });
    }
  });

  async function enqueueFinal({ sessionId, meetingId } = {}) {
    if (!nonEmpty(sessionId) || !nonEmpty(meetingId)) throw new TypeError('sessionId and meetingId must be non-empty strings.');
    const job = await jobRepository.enqueue({ jobId: idGenerator('meeting-summary-job'), idempotencyKey: `final:${sessionId}`, kind: 'final', range: null, sessionId, meetingId, status: 'queued', attempt: 0, fenceToken: 0, enqueuedAt: clock(), availableAt: null });
    if (job.status === 'queued') await activeQueue.enqueue({ jobId: job.jobId, sessionId: job.sessionId, meetingId: job.meetingId });
    return job;
  }
}

function nonEmpty(value) { return typeof value === 'string' && value.trim() !== ''; }
