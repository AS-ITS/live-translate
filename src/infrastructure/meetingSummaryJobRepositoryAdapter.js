import { MeetingSummaryJob } from '../domain/meetingSummaryJob/index.js';
import { MEETING_SUMMARY_JOB_REPOSITORY_METHODS } from '../domain/meetingSummaryJob/meetingSummaryJobRepository.js';

export function createMemoryMeetingSummaryJobRepository() {
  const jobs = new Map();
  return wrap({
    async enqueue(input) {
      const key = input.idempotencyKey ?? (input.kind === 'partial' ? `partial:${input.sessionId}:${input.range?.rangeKey}` : `final:${input.sessionId}`);
      const existing = [...jobs.values()].find((job) => job.idempotencyKey === key && ['queued', 'processing', 'completed'].includes(job.status));
      if (existing) return new MeetingSummaryJob(existing);
      const job = new MeetingSummaryJob({ ...input, idempotencyKey: key });
      if (jobs.has(job.jobId)) throw new Error(`Meeting summary job already exists: ${job.jobId}`);
      jobs.set(job.jobId, plain(job));
      return new MeetingSummaryJob(job);
    },
    async get(jobId) { const job = jobs.get(jobId); return job ? new MeetingSummaryJob(job) : null; },
    async getActiveBySessionId(sessionId) {
      const job = [...jobs.values()].find((item) => item.sessionId === sessionId && (item.kind ?? 'final') === 'final' && ['queued', 'processing', 'completed'].includes(item.status));
      return job ? new MeetingSummaryJob(job) : null;
    },
    async list() { return [...jobs.values()].map((job) => new MeetingSummaryJob(job)); },
    async listAvailable(now) { return [...jobs.values()].filter((job) => job.status === 'queued' && (!job.availableAt || job.availableAt <= now)).map((job) => new MeetingSummaryJob(job)); },
    async nextAvailableAt(now) { return [...jobs.values()].filter((job) => job.status === 'queued' && job.availableAt && job.availableAt > now).map((job) => job.availableAt).sort()[0] ?? null; },
    async claim(jobId, lease) { return transition(jobs, jobId, (job) => job.claim(lease), lease); },
    async retry(jobId, claim, input) { return transition(jobs, jobId, (job) => assertClaim(job, claim).retry(input)); },
    async complete(jobId, claim, completedAt) { return transition(jobs, jobId, (job) => assertClaim(job, claim).complete(completedAt)); },
    async fail(jobId, claim, input) { return transition(jobs, jobId, (job) => assertClaim(job, claim).fail(input)); },
    async reclaimExpired(jobId, now) {
      return transitionIf(jobs, jobId, (job) => job.status === 'processing' && new Date(job.leaseExpiresAt).getTime() <= new Date(now).getTime(), (job) => job.reclaim({ availableAt: null }));
    }
  });
}

function transition(store, jobId, operation, claim) {
  const next = transitionIf(store, jobId, () => true, operation, claim);
  if (!next) throw notFound(jobId);
  return next;
}

function transitionIf(store, jobId, predicate, operation) {
  const current = store.get(jobId);
  if (!current || !predicate(current)) return null;
  const next = operation(new MeetingSummaryJob(current));
  store.set(jobId, plain(next));
  return new MeetingSummaryJob(next);
}

function assertClaim(job, claim) {
  if (!claim || job.status !== 'processing' || job.leaseId !== claim.leaseId || job.fenceToken !== claim.fenceToken) {
    const error = new Error('Meeting summary job lease ownership does not match.');
    error.code = 'meeting_summary_job_lease_ownership_error';
    throw error;
  }
  return job;
}

function notFound(jobId) { const error = new Error(`Meeting summary job not found: ${jobId}`); error.code = 'meeting_summary_job_not_found'; return error; }
function plain(value) { return JSON.parse(JSON.stringify(value)); }
function wrap(implementation) { return Object.freeze(Object.fromEntries(MEETING_SUMMARY_JOB_REPOSITORY_METHODS.map((method) => [method, implementation[method]]))); }
