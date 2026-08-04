export const MEETING_SUMMARY_JOB_STATUSES = Object.freeze(['queued', 'processing', 'completed', 'failed']);
export const MEETING_SUMMARY_JOB_KINDS = Object.freeze(['partial', 'final']);

export class MeetingSummaryJob {
  constructor(input = {}) {
    if (!isRecord(input)) throw new TypeError('MeetingSummaryJob input must be an object.');
    this.jobId = requiredString(input.jobId, 'jobId');
    this.sessionId = requiredString(input.sessionId, 'sessionId');
    this.meetingId = requiredString(input.meetingId, 'meetingId');
    this.kind = kind(input.kind ?? 'final');
    this.range = input.range === null || input.range === undefined ? null : cloneRange(input.range);
    this.idempotencyKey = requiredString(input.idempotencyKey ?? (this.kind === 'final' ? `final:${this.sessionId}` : `partial:${this.sessionId}:${this.range?.rangeKey}`), 'idempotencyKey');
    this.status = status(input.status ?? 'queued');
    this.attempt = nonNegativeInteger(input.attempt ?? 0, 'attempt');
    this.fenceToken = nonNegativeInteger(input.fenceToken ?? 0, 'fenceToken');
    this.enqueuedAt = requiredTimestamp(input.enqueuedAt, 'enqueuedAt');
    this.availableAt = nullableTimestamp(input.availableAt ?? null, 'availableAt');
    this.claimedAt = nullableTimestamp(input.claimedAt ?? null, 'claimedAt');
    this.leaseId = nullableString(input.leaseId ?? null, 'leaseId');
    this.leaseExpiresAt = nullableTimestamp(input.leaseExpiresAt ?? null, 'leaseExpiresAt');
    this.completedAt = nullableTimestamp(input.completedAt ?? null, 'completedAt');
    this.failedAt = nullableTimestamp(input.failedAt ?? null, 'failedAt');
    this.failureInfo = input.failureInfo === null || input.failureInfo === undefined ? null : clone(input.failureInfo);
    validateState(this);
    deepFreeze(this);
  }

  claim({ leaseId, claimedAt, leaseExpiresAt } = {}) {
    if (this.status !== 'queued') throw coded('meeting_summary_job_not_claimable', `Summary job cannot be claimed from ${this.status}.`);
    return new MeetingSummaryJob({
      ...plain(this), status: 'processing', attempt: this.attempt + 1, fenceToken: this.fenceToken + 1,
      leaseId: requiredString(leaseId, 'leaseId'), claimedAt, leaseExpiresAt, availableAt: null, failureInfo: null
    });
  }

  retry({ availableAt, failureInfo } = {}) {
    if (this.status !== 'processing') throw coded('meeting_summary_job_not_claimable', `Summary job cannot retry from ${this.status}.`);
    return new MeetingSummaryJob({
      ...plain(this), status: 'queued', availableAt, failureInfo: clone(failureInfo),
      claimedAt: null, leaseId: null, leaseExpiresAt: null
    });
  }

  complete(completedAt) {
    if (this.status !== 'processing') throw coded('meeting_summary_job_not_claimable', `Summary job cannot complete from ${this.status}.`);
    return new MeetingSummaryJob({
      ...plain(this), status: 'completed', completedAt,
      claimedAt: null, leaseId: null, leaseExpiresAt: null, failureInfo: null
    });
  }

  fail({ failedAt, failureInfo } = {}) {
    if (this.status !== 'processing') throw coded('meeting_summary_job_not_claimable', `Summary job cannot fail from ${this.status}.`);
    return new MeetingSummaryJob({
      ...plain(this), status: 'failed', failedAt, failureInfo: clone(failureInfo),
      claimedAt: null, leaseId: null, leaseExpiresAt: null
    });
  }

  reclaim({ availableAt } = {}) {
    if (this.status !== 'processing') throw coded('meeting_summary_job_not_claimable', `Summary job cannot reclaim from ${this.status}.`);
    return new MeetingSummaryJob({
      ...plain(this), status: 'queued', availableAt,
      claimedAt: null, leaseId: null, leaseExpiresAt: null
    });
  }
}

function validateState(job) {
  if (job.kind === 'partial' && !job.range) throw new TypeError('partial meeting summary jobs require a range.');
  if (job.kind === 'final' && job.range !== null) throw new TypeError('final meeting summary jobs cannot contain a range.');
  const processing = job.status === 'processing';
  if (processing && (!job.leaseId || !job.claimedAt || !job.leaseExpiresAt)) throw new TypeError('Processing summary jobs require an active lease.');
  if (!processing && (job.leaseId || job.claimedAt || job.leaseExpiresAt)) throw new TypeError('Only processing summary jobs may have an active lease.');
  if (job.status === 'completed' && !job.completedAt) throw new TypeError('Completed summary jobs require completedAt.');
  if (job.status === 'failed' && (!job.failedAt || !job.failureInfo)) throw new TypeError('Failed summary jobs require failedAt and failureInfo.');
  if (!['queued', 'failed'].includes(job.status) && job.failureInfo !== null) throw new TypeError('Only queued or failed summary jobs may have failureInfo.');
}

function status(value) { if (!MEETING_SUMMARY_JOB_STATUSES.includes(value)) throw new TypeError(`Unsupported meeting summary job status: ${value}`); return value; }
function kind(value) { if (!MEETING_SUMMARY_JOB_KINDS.includes(value)) throw new TypeError(`Unsupported meeting summary job kind: ${value}`); return value; }
function requiredString(value, field) { if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string.`); return value; }
function nullableString(value, field) { return value === null ? null : requiredString(value, field); }
function nonNegativeInteger(value, field) { if (!Number.isInteger(value) || value < 0) throw new TypeError(`${field} must be a non-negative integer.`); return value; }
function requiredTimestamp(value, field) { if (!isTimestamp(value)) throw new TypeError(`${field} must be a timestamp.`); return value; }
function nullableTimestamp(value, field) { return value === null ? null : requiredTimestamp(value, field); }
function isTimestamp(value) { return (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && !Number.isNaN(new Date(value).getTime())); }
function coded(code, message) { const error = new Error(message); error.code = code; return error; }
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function clone(value) { if (!isRecord(value)) throw new TypeError('failureInfo must be an object.'); return JSON.parse(JSON.stringify(value)); }
function cloneRange(value) { if (!isRecord(value) || typeof value.rangeKey !== 'string' || !Number.isInteger(value.segmentSequence)) throw new TypeError('summary job range is invalid.'); return JSON.parse(JSON.stringify(value)); }
function plain(value) { return JSON.parse(JSON.stringify(value)); }
function deepFreeze(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; Object.freeze(value); Object.values(value).forEach(deepFreeze); return value; }
