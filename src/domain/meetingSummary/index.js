export const MEETING_SUMMARY_STATUSES = Object.freeze(['pending', 'completed', 'failed']);

export class MeetingSummary {
  constructor(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('MeetingSummary input must be an object.');
    this.summaryId = requiredString(input.summaryId, 'summaryId');
    this.sessionId = requiredString(input.sessionId, 'sessionId');
    this.status = status(input.status ?? 'pending');
    this.model = requiredString(input.model, 'model');
    this.summary = input.summary === null || input.summary === undefined ? null : objectValue(input.summary, 'summary');
    this.topics = stringArray(input.topics, 'topics');
    this.decisions = stringArray(input.decisions, 'decisions');
    this.actionItems = stringArray(input.actionItems, 'actionItems');
    this.createdAt = requiredTimestamp(input.createdAt, 'createdAt');
    this.completedAt = input.completedAt === null || input.completedAt === undefined
      ? null
      : requiredTimestamp(input.completedAt, 'completedAt');
    validateState(this);
    deepFreeze(this);
  }

  complete({ summary, topics = [], decisions = [], actionItems = [], completedAt } = {}) {
    if (this.status !== 'pending') throw new RangeError(`meeting summary cannot complete from ${this.status}`);
    return new MeetingSummary({
      ...this,
      status: 'completed',
      summary,
      topics,
      decisions,
      actionItems,
      completedAt
    });
  }

  fail() {
    if (this.status !== 'pending') throw new RangeError(`meeting summary cannot fail from ${this.status}`);
    return new MeetingSummary({ ...this, status: 'failed', summary: null, topics: [], decisions: [], actionItems: [], completedAt: null });
  }
}

function validateState(summary) {
  if (summary.status === 'completed') {
    if (summary.summary === null || summary.completedAt === null) throw new TypeError('completed meeting summaries require summary and completedAt.');
  } else if (summary.summary !== null || summary.completedAt !== null || summary.topics.length > 0 || summary.decisions.length > 0 || summary.actionItems.length > 0) {
    throw new TypeError(`${summary.status} meeting summaries cannot contain completed summary data.`);
  }
}

function requiredString(value, field) { if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string.`); return value; }
function status(value) { if (!MEETING_SUMMARY_STATUSES.includes(value)) throw new TypeError(`meeting summary status is not supported: ${value}`); return value; }
function objectValue(value, field) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${field} must be an object.`); return clone(value); }
function stringArray(value, field) { if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new TypeError(`${field} must be an array of strings.`); return value.map((item) => item.trim()).filter(Boolean); }
function requiredTimestamp(value, field) { if (!Number.isFinite(value) && !(typeof value === 'string' && value.trim() !== '')) throw new TypeError(`${field} must be a timestamp.`); return value; }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function deepFreeze(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); return value; }
