import { dirname } from 'node:path';
import { MeetingSummaryJob } from '../domain/meetingSummaryJob/index.js';
import { MEETING_SUMMARY_JOB_REPOSITORY_METHODS } from '../domain/meetingSummaryJob/meetingSummaryJobRepository.js';

const INITIAL_STORAGE = Object.freeze({ schemaVersion: 1, jobs: Object.freeze([]) });

export function createFileMeetingSummaryJobRepository({ filePath, fileSystem } = {}) {
  if (typeof filePath !== 'string' || !filePath.trim()) throw new TypeError('filePath must be a non-empty string.');
  if (!fileSystem || !['readFile', 'mkdir', 'writeFile', 'rename'].every((method) => typeof fileSystem[method] === 'function')) throw new TypeError('fileSystem must support readFile, mkdir, writeFile, and rename.');
  let mutationQueue = Promise.resolve();

  const implementation = {
    async enqueue(input) { return mutate((storage) => {
      const key = input.idempotencyKey ?? (input.kind === 'partial' ? `partial:${input.sessionId}:${input.range?.rangeKey}` : `final:${input.sessionId}`);
      const existing = storage.jobs.find((job) => job.idempotencyKey === key && ['queued', 'processing', 'completed'].includes(job.status));
      if (existing) return new MeetingSummaryJob(existing);
      const job = new MeetingSummaryJob({ ...input, idempotencyKey: key });
      if (storage.jobs.some((item) => item.jobId === job.jobId)) throw new Error(`Meeting summary job already exists: ${job.jobId}`);
      storage.jobs.push(plain(job));
      return job;
    }); },
    async get(jobId) { const storage = await readStorage(); const job = storage.jobs.find((item) => item.jobId === jobId); return job ? new MeetingSummaryJob(job) : null; },
    async getActiveBySessionId(sessionId) { const storage = await readStorage(); const job = storage.jobs.find((item) => item.sessionId === sessionId && (item.kind ?? 'final') === 'final' && ['queued', 'processing', 'completed'].includes(item.status)); return job ? new MeetingSummaryJob(job) : null; },
    async list() { const storage = await readStorage(); return storage.jobs.map((job) => new MeetingSummaryJob(job)); },
    async listAvailable(now) { const storage = await readStorage(); return storage.jobs.filter((job) => job.status === 'queued' && (!job.availableAt || job.availableAt <= now)).map((job) => new MeetingSummaryJob(job)); },
    async nextAvailableAt(now) { const storage = await readStorage(); return storage.jobs.filter((job) => job.status === 'queued' && job.availableAt && job.availableAt > now).map((job) => job.availableAt).sort()[0] ?? null; },
    async claim(jobId, lease) { return mutate((storage) => transition(storage, jobId, (job) => job.claim(lease), true)); },
    async retry(jobId, claim, input) { return mutate((storage) => transition(storage, jobId, (job) => assertClaim(job, claim).retry(input))); },
    async complete(jobId, claim, completedAt) { return mutate((storage) => transition(storage, jobId, (job) => assertClaim(job, claim).complete(completedAt))); },
    async fail(jobId, claim, input) { return mutate((storage) => transition(storage, jobId, (job) => assertClaim(job, claim).fail(input))); },
    async reclaimExpired(jobId, now) { return mutate((storage) => {
      const item = storage.jobs.find((job) => job.jobId === jobId);
      if (!item || item.status !== 'processing' || new Date(item.leaseExpiresAt).getTime() > new Date(now).getTime()) return null;
      return transition(storage, jobId, (job) => job.reclaim({ availableAt: null }));
    }); }
  };

  return Object.freeze(Object.fromEntries(MEETING_SUMMARY_JOB_REPOSITORY_METHODS.map((method) => [method, implementation[method]])));

  function mutate(operation) {
    const next = mutationQueue.then(async () => { const storage = await readStorage(); const result = await operation(storage); await writeStorage(storage); return result; });
    mutationQueue = next.catch(() => {});
    return next;
  }

  async function readStorage() {
    let raw;
    try { raw = await fileSystem.readFile(filePath, 'utf8'); } catch (error) { if (error?.code === 'ENOENT') return clone(INITIAL_STORAGE); throw error; }
    let parsed; try { parsed = JSON.parse(raw); } catch { throw new TypeError('Meeting summary job repository JSON is invalid.'); }
    if (!parsed || parsed.schemaVersion !== 1 || !Array.isArray(parsed.jobs)) throw new TypeError('Meeting summary job repository storage shape is invalid.');
    parsed.jobs.forEach((job) => new MeetingSummaryJob(job));
    return { schemaVersion: 1, jobs: parsed.jobs.map(clone) };
  }

  async function writeStorage(storage) { await fileSystem.mkdir(dirname(filePath), { recursive: true }); const temporaryPath = `${filePath}.tmp`; await fileSystem.writeFile(temporaryPath, `${JSON.stringify(storage, null, 2)}\n`, 'utf8'); await fileSystem.rename(temporaryPath, filePath); }
}

function transition(storage, jobId, operation) {
  const index = storage.jobs.findIndex((job) => job.jobId === jobId);
  if (index === -1) throw notFound(jobId);
  const next = operation(new MeetingSummaryJob(storage.jobs[index]));
  storage.jobs[index] = plain(next);
  return next;
}
function assertClaim(job, claim) { if (!claim || job.status !== 'processing' || job.leaseId !== claim.leaseId || job.fenceToken !== claim.fenceToken) { const error = new Error('Meeting summary job lease ownership does not match.'); error.code = 'meeting_summary_job_lease_ownership_error'; throw error; } return job; }
function notFound(jobId) { const error = new Error(`Meeting summary job not found: ${jobId}`); error.code = 'meeting_summary_job_not_found'; return error; }
function plain(value) { return JSON.parse(JSON.stringify(value)); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
