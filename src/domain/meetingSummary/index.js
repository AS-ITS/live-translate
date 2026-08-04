export const MEETING_SUMMARY_STATUSES = Object.freeze(['pending', 'completed', 'failed']);
export const MEETING_SUMMARY_KINDS = Object.freeze(['partial', 'final']);

export class MeetingSummary {
  constructor(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('MeetingSummary input must be an object.');
    this.summaryId = requiredString(input.summaryId, 'summaryId');
    this.sessionId = requiredString(input.sessionId, 'sessionId');
    if (Object.prototype.hasOwnProperty.call(input, 'kind')) this.kind = kind(input.kind);
    if (Object.prototype.hasOwnProperty.call(input, 'range')) this.range = input.range === null || input.range === undefined ? null : rangeValue(input.range);
    this.status = status(input.status ?? 'pending');
    this.model = requiredString(input.model, 'model');
    this.summary = input.summary === null || input.summary === undefined ? null : objectValue(input.summary, 'summary');
    this.topics = stringArray(input.topics, 'topics');
    this.decisions = stringArray(input.decisions, 'decisions');
    this.actionItems = stringArray(input.actionItems, 'actionItems');
    this.timeline = timelineArray(input.timeline);
    this.keywords = stringArray(input.keywords ?? [], 'keywords');
    this.risks = stringArray(input.risks ?? [], 'risks');
    this.openQuestions = stringArray(input.openQuestions ?? [], 'openQuestions');
    this.followUpSuggestions = stringArray(input.followUpSuggestions ?? [], 'followUpSuggestions');
    this.createdAt = requiredTimestamp(input.createdAt, 'createdAt');
    this.completedAt = input.completedAt === null || input.completedAt === undefined
      ? null
      : requiredTimestamp(input.completedAt, 'completedAt');
    validateState(this);
    deepFreeze(this);
  }

  complete({ summary, topics = [], decisions = [], actionItems = [], timeline = [], keywords = [], risks = [], openQuestions = [], followUpSuggestions = [], completedAt } = {}) {
    if (this.status !== 'pending') throw new RangeError(`meeting summary cannot complete from ${this.status}`);
    return new MeetingSummary({
      ...this,
      status: 'completed',
      summary,
      topics,
      decisions,
      actionItems,
      timeline,
      keywords,
      risks,
      openQuestions,
      followUpSuggestions,
      completedAt
    });
  }

  fail() {
    if (this.status !== 'pending') throw new RangeError(`meeting summary cannot fail from ${this.status}`);
    return new MeetingSummary({ ...this, status: 'failed', summary: null, topics: [], decisions: [], actionItems: [], timeline: [], keywords: [], risks: [], openQuestions: [], followUpSuggestions: [], completedAt: null });
  }
}

function validateState(summary) {
  const summaryKind = summary.kind ?? 'final';
  const summaryRange = summary.range ?? null;
  if (summaryKind === 'partial' && summaryRange === null) throw new TypeError('partial meeting summaries require a range.');
  if (summaryKind === 'final' && summaryRange !== null) throw new TypeError('final meeting summaries cannot contain a range.');
  if (summary.status === 'completed') {
    if (summary.summary === null || summary.completedAt === null) throw new TypeError('completed meeting summaries require summary and completedAt.');
  } else if (summary.summary !== null || summary.completedAt !== null || summary.topics.length > 0 || summary.decisions.length > 0 || summary.actionItems.length > 0 || summary.timeline.length > 0 || summary.keywords.length > 0 || summary.risks.length > 0 || summary.openQuestions.length > 0 || summary.followUpSuggestions.length > 0) {
    throw new TypeError(`${summary.status} meeting summaries cannot contain completed summary data.`);
  }
}

function requiredString(value, field) { if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string.`); return value; }
function status(value) { if (!MEETING_SUMMARY_STATUSES.includes(value)) throw new TypeError(`meeting summary status is not supported: ${value}`); return value; }
function kind(value) { if (!MEETING_SUMMARY_KINDS.includes(value)) throw new TypeError(`meeting summary kind is not supported: ${value}`); return value; }
function rangeValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('summary range must be an object.');
  const required = ['segmentId', 'segmentSequence', 'startCueId', 'endCueId'];
  for (const field of required) {
    const valid = field === 'segmentSequence' ? Number.isInteger(value[field]) : typeof value[field] === 'string' && value[field].trim() !== '';
    if (!valid) throw new TypeError(`summary range.${field} is invalid.`);
  }
  if (value.segmentSequence < 0) throw new TypeError('summary range.segmentSequence is invalid.');
  return clone({ segmentId: value.segmentId, segmentSequence: value.segmentSequence, startCueId: value.startCueId, endCueId: value.endCueId, rangeKey: value.rangeKey ?? `${value.segmentSequence}:${value.segmentId}:${value.startCueId}:${value.endCueId}` });
}
function objectValue(value, field) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${field} must be an object.`); return clone(value); }
function stringArray(value, field) { if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new TypeError(`${field} must be an array of strings.`); return value.map((item) => item.trim()).filter(Boolean); }
function timelineArray(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new TypeError('timeline must be an array.');
  return value.filter((item) => item && typeof item === 'object' && !Array.isArray(item)).map(clone).sort(compareTimeline);
}
function requiredTimestamp(value, field) { if (!Number.isFinite(value) && !(typeof value === 'string' && value.trim() !== '')) throw new TypeError(`${field} must be a timestamp.`); return value; }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function deepFreeze(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); return value; }
function compareTimeline(left, right) { return timelineTime(left) - timelineTime(right) || (Number.isFinite(left.endTimeMs) ? left.endTimeMs : 0) - (Number.isFinite(right.endTimeMs) ? right.endTimeMs : 0); }
function timelineTime(value) { return Number.isFinite(value.startTimeMs) ? value.startTimeMs : Number.isFinite(value.timestampMs) ? value.timestampMs : Number.POSITIVE_INFINITY; }
