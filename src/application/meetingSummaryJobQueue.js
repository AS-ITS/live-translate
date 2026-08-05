export function createMeetingSummaryJobQueue() {
  const jobs = [];
  const queued = new Set();

  return Object.freeze({
    enqueue(job) {
      assertJob(job);
      if (queued.has(job.jobId)) return false;
      jobs.push({ jobId: job.jobId, sessionId: job.sessionId, meetingId: job.meetingId });
      queued.add(job.jobId);
      return true;
    },
    dequeue() {
      const job = jobs.shift() || null;
      if (job) queued.delete(job.jobId);
      return job;
    },
    size() { return jobs.length; }
  });
}

function assertJob(job) {
  if (!job || typeof job !== 'object' || typeof job.jobId !== 'string' || typeof job.sessionId !== 'string' || typeof job.meetingId !== 'string') {
    throw new TypeError('Meeting summary queue job must contain jobId, sessionId, and meetingId.');
  }
}
