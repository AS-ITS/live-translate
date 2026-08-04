import { assertMeetingSummaryJobRepository } from '../domain/meetingSummaryJob/meetingSummaryJobRepository.js';

export function createMeetingSummaryRecovery({ jobRepository, activeQueue, clock = () => new Date().toISOString() } = {}) {
  assertMeetingSummaryJobRepository(jobRepository);
  if (!activeQueue || typeof activeQueue.enqueue !== 'function') throw new TypeError('activeQueue.enqueue is required.');
  return Object.freeze({
    async recover() {
      const now = clock();
      let recovered = 0;
      for (const job of await jobRepository.list()) {
        let next = job;
        if (job.status === 'processing' && new Date(job.leaseExpiresAt).getTime() <= new Date(now).getTime()) {
          next = await jobRepository.reclaimExpired(job.jobId, now);
        }
        if (next?.status === 'queued' && (!next.availableAt || next.availableAt <= now)) {
          if (await activeQueue.enqueue({ jobId: next.jobId, sessionId: next.sessionId, meetingId: next.meetingId })) recovered += 1;
        }
      }
      return recovered;
    }
  });
}
