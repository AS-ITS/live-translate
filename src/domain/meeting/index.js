export const MEETING_STATUSES = Object.freeze(['created', 'active', 'completed', 'interrupted', 'failed']);
export const MEETING_SEGMENT_STATUSES = Object.freeze(['created', 'active', 'completed', 'interrupted', 'failed']);

const TERMINAL_MEETING_STATUSES = new Set(['completed', 'failed']);
const TERMINAL_SEGMENT_STATUSES = new Set(['completed', 'failed']);
const ALLOWED_MEETING_TRANSITIONS = Object.freeze({
  created: Object.freeze(['active', 'failed']),
  active: Object.freeze(['completed', 'interrupted', 'failed']),
  interrupted: Object.freeze(['active', 'failed']),
  completed: Object.freeze([]),
  failed: Object.freeze([])
});
const ALLOWED_SEGMENT_TRANSITIONS = Object.freeze({
  created: Object.freeze(['active', 'failed']),
  active: Object.freeze(['completed', 'interrupted', 'failed']),
  interrupted: Object.freeze(['active', 'failed']),
  completed: Object.freeze([]),
  failed: Object.freeze([])
});

export class Meeting {
  constructor(input = {}) {
    assertInputObject(input, 'Meeting input');

    this.id = assertRequiredString(input.id, 'id');
    this.status = assertMeetingStatus(input.status ?? 'created');
    this.startedAt = input.startedAt ?? null;
    this.endedAt = input.endedAt ?? null;
    this.createdAt = assertTimestamp(input.createdAt, 'createdAt');
    this.updatedAt = assertTimestamp(input.updatedAt ?? input.createdAt, 'updatedAt');
    this.failureInfo = deepClone(input.failureInfo ?? null);
    this.name = normalizeOptionalString(input.name);
    this.sourceLanguageCode = normalizeOptionalString(input.sourceLanguageCode);
    this.targetLanguageCode = normalizeOptionalString(input.targetLanguageCode);
    this.glossaryEntries = normalizeGlossaryEntries(input.glossaryEntries);

    validateMeetingState(this);
    deepFreeze(this);
  }

  activate(startedAt = this.startedAt ?? this.updatedAt) {
    return this.transitionTo('active', {
      startedAt: assertTimestamp(startedAt, 'startedAt'),
      endedAt: null,
      failureInfo: null
    });
  }

  complete(endedAt) {
    return this.transitionTo('completed', {
      endedAt: assertTimestamp(endedAt, 'endedAt'),
      failureInfo: null
    });
  }

  interrupt(endedAt) {
    return this.transitionTo('interrupted', {
      endedAt: assertTimestamp(endedAt, 'endedAt'),
      failureInfo: null
    });
  }

  fail(failureInfo, endedAt) {
    return this.transitionTo('failed', {
      endedAt: assertTimestamp(endedAt, 'endedAt'),
      failureInfo: deepClone(assertRequiredValue(failureInfo, 'failureInfo'))
    });
  }

  transitionTo(status, patch = {}) {
    const nextStatus = assertMeetingStatus(status);

    if (nextStatus !== this.status && !ALLOWED_MEETING_TRANSITIONS[this.status].includes(nextStatus)) {
      throw new RangeError(`meeting status transition from ${this.status} to ${nextStatus} is not allowed`);
    }

    return new Meeting({
      id: this.id,
      status: nextStatus,
      startedAt: Object.hasOwn(patch, 'startedAt') ? patch.startedAt : this.startedAt,
      endedAt: Object.hasOwn(patch, 'endedAt') ? patch.endedAt : this.endedAt,
      createdAt: this.createdAt,
      updatedAt: patch.updatedAt ?? patch.endedAt ?? patch.startedAt ?? this.updatedAt,
      failureInfo: Object.hasOwn(patch, 'failureInfo') ? patch.failureInfo : this.failureInfo,
      name: Object.hasOwn(patch, 'name') ? normalizeOptionalString(patch.name) : this.name,
      sourceLanguageCode: Object.hasOwn(patch, 'sourceLanguageCode') ? normalizeOptionalString(patch.sourceLanguageCode) : this.sourceLanguageCode,
      targetLanguageCode: Object.hasOwn(patch, 'targetLanguageCode') ? normalizeOptionalString(patch.targetLanguageCode) : this.targetLanguageCode,
      glossaryEntries: Object.hasOwn(patch, 'glossaryEntries')
        ? normalizeGlossaryEntries(patch.glossaryEntries)
        : this.glossaryEntries
    });
  }

  withSettings(settings = {}) {
    if (isTerminalMeetingStatus(this.status)) {
      throw new RangeError(`meeting settings cannot be changed for ${this.status} meeting`);
    }
    return this.transitionTo(this.status, {
      ...settings,
      updatedAt: settings.updatedAt ?? this.updatedAt,
      glossaryEntries: normalizeGlossaryEntries(settings.glossaryEntries ?? this.glossaryEntries)
    });
  }
}

export class MeetingSegment {
  constructor(input = {}) {
    assertInputObject(input, 'MeetingSegment input');

    this.id = assertRequiredString(input.id, 'id');
    this.meetingId = assertRequiredString(input.meetingId, 'meetingId');
    this.sequence = assertNonNegativeInteger(input.sequence, 'sequence');
    this.status = assertMeetingSegmentStatus(input.status ?? 'created');
    this.startedAt = input.startedAt ?? null;
    this.endedAt = input.endedAt ?? null;
    this.liveSessionId = assertOptionalString(input.liveSessionId, 'liveSessionId') ?? null;
    this.settingsSnapshot = input.settingsSnapshot ? deepClone(input.settingsSnapshot) : null;
    this.checkpoint = deepClone(input.checkpoint ?? null);
    this.errorInfo = deepClone(input.errorInfo ?? null);
    this.createdAt = assertTimestamp(input.createdAt, 'createdAt');
    this.updatedAt = assertTimestamp(input.updatedAt ?? input.createdAt, 'updatedAt');

    validateMeetingSegmentState(this);
    deepFreeze(this);
  }

  activate(startedAt = this.startedAt ?? this.updatedAt) {
    return this.transitionTo('active', {
      startedAt: assertTimestamp(startedAt, 'startedAt'),
      endedAt: null,
      errorInfo: null
    });
  }

  complete({ endedAt, checkpoint = this.checkpoint, liveSessionId = this.liveSessionId } = {}) {
    return this.transitionTo('completed', {
      endedAt: assertTimestamp(endedAt, 'endedAt'),
      checkpoint,
      liveSessionId,
      errorInfo: null
    });
  }

  interrupt({ endedAt, checkpoint = this.checkpoint, errorInfo = this.errorInfo, liveSessionId = this.liveSessionId } = {}) {
    return this.transitionTo('interrupted', {
      endedAt: assertTimestamp(endedAt, 'endedAt'),
      checkpoint,
      errorInfo,
      liveSessionId
    });
  }

  fail({ endedAt, errorInfo, checkpoint = this.checkpoint, liveSessionId = this.liveSessionId } = {}) {
    return this.transitionTo('failed', {
      endedAt: assertTimestamp(endedAt, 'endedAt'),
      checkpoint,
      liveSessionId,
      errorInfo: deepClone(assertRequiredValue(errorInfo, 'errorInfo'))
    });
  }

  withLiveSession(liveSessionId) {
    if (TERMINAL_SEGMENT_STATUSES.has(this.status)) {
      throw new RangeError(`liveSessionId cannot be changed for ${this.status} segment`);
    }

    return new MeetingSegment({
      ...this,
      liveSessionId: assertRequiredString(liveSessionId, 'liveSessionId'),
      updatedAt: this.updatedAt
    });
  }

  withCheckpoint(checkpoint, updatedAt = this.updatedAt) {
    if (TERMINAL_SEGMENT_STATUSES.has(this.status)) {
      throw new RangeError(`checkpoint cannot be changed for ${this.status} segment`);
    }

    return new MeetingSegment({
      ...this,
      checkpoint: deepClone(checkpoint),
      updatedAt: assertTimestamp(updatedAt, 'updatedAt')
    });
  }

  transitionTo(status, patch = {}) {
    const nextStatus = assertMeetingSegmentStatus(status);

    if (!ALLOWED_SEGMENT_TRANSITIONS[this.status].includes(nextStatus)) {
      throw new RangeError(`meeting segment status transition from ${this.status} to ${nextStatus} is not allowed`);
    }

    return new MeetingSegment({
      id: this.id,
      meetingId: this.meetingId,
      sequence: this.sequence,
      status: nextStatus,
      startedAt: Object.hasOwn(patch, 'startedAt') ? patch.startedAt : this.startedAt,
      endedAt: Object.hasOwn(patch, 'endedAt') ? patch.endedAt : this.endedAt,
      liveSessionId: Object.hasOwn(patch, 'liveSessionId') ? patch.liveSessionId : this.liveSessionId,
      settingsSnapshot: Object.hasOwn(patch, 'settingsSnapshot') ? patch.settingsSnapshot : this.settingsSnapshot,
      checkpoint: Object.hasOwn(patch, 'checkpoint') ? patch.checkpoint : this.checkpoint,
      errorInfo: Object.hasOwn(patch, 'errorInfo') ? patch.errorInfo : this.errorInfo,
      createdAt: this.createdAt,
      updatedAt: patch.updatedAt ?? patch.endedAt ?? patch.startedAt ?? this.updatedAt
    });
  }
}

export function isTerminalMeetingStatus(status) {
  return TERMINAL_MEETING_STATUSES.has(status);
}

export function isTerminalMeetingSegmentStatus(status) {
  return TERMINAL_SEGMENT_STATUSES.has(status);
}

function validateMeetingState(meeting) {
  if (meeting.status === 'created') {
    if (meeting.startedAt !== null || meeting.endedAt !== null || meeting.failureInfo !== null) {
      throw new RangeError('created meeting cannot have lifecycle timestamps or failureInfo');
    }
    return;
  }

  if (meeting.status === 'active') {
    assertTimestamp(meeting.startedAt, 'startedAt');
    if (meeting.endedAt !== null || meeting.failureInfo !== null) {
      throw new RangeError('active meeting cannot have endedAt or failureInfo');
    }
    return;
  }

  assertTimestamp(meeting.endedAt, 'endedAt');

  if (meeting.status !== 'failed') {
    assertTimestamp(meeting.startedAt, 'startedAt');
  }

  if (meeting.status === 'failed') {
    assertRequiredValue(meeting.failureInfo, 'failureInfo');
  } else if (meeting.failureInfo !== null) {
    throw new RangeError(`failureInfo is not allowed for ${meeting.status} meeting`);
  }
}

function normalizeGlossaryEntries(value) {
  if (value === undefined || value === null) return Object.freeze([]);
  if (!Array.isArray(value)) throw new TypeError('Meeting glossaryEntries must be an array.');

  return Object.freeze(value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError(`Meeting glossary entry ${index} must be an object.`);
    }
    if (typeof entry.source !== 'string' || entry.source.trim() === '') {
      throw new TypeError(`Meeting glossary entry ${index}.source must be a non-empty string.`);
    }
    if (typeof entry.target !== 'string' || entry.target.trim() === '') {
      throw new TypeError(`Meeting glossary entry ${index}.target must be a non-empty string.`);
    }
    const replacementAliases = entry.replacementAliases === undefined ? [] : entry.replacementAliases;
    if (!Array.isArray(replacementAliases) || replacementAliases.some((alias) => typeof alias !== 'string' || alias.trim() === '')) {
      throw new TypeError(`Meeting glossary entry ${index}.replacementAliases must be an array of non-empty strings.`);
    }
    return Object.freeze({
      source: entry.source,
      target: entry.target,
      replacementAliases: Object.freeze([...replacementAliases])
    });
  }));
}

function normalizeOptionalString(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError('Meeting setting must be a non-empty string.');
  return value.trim();
}

function validateMeetingSegmentState(segment) {
  if (segment.status === 'created') {
    if (segment.startedAt !== null || segment.endedAt !== null || segment.errorInfo !== null) {
      throw new RangeError('created segment cannot have lifecycle timestamps or errorInfo');
    }
    return;
  }

  if (segment.status === 'active') {
    assertTimestamp(segment.startedAt, 'startedAt');
    if (segment.endedAt !== null || segment.errorInfo !== null) {
      throw new RangeError('active segment cannot have endedAt or errorInfo');
    }
    return;
  }

  assertTimestamp(segment.endedAt, 'endedAt');

  if (segment.status !== 'failed') {
    assertTimestamp(segment.startedAt, 'startedAt');
  }

  if (segment.status === 'failed') {
    assertRequiredValue(segment.errorInfo, 'errorInfo');
  } else if (segment.status === 'completed' && segment.errorInfo !== null) {
    throw new RangeError('errorInfo is not allowed for completed segment');
  }
}

function assertMeetingStatus(value) {
  if (typeof value !== 'string') throw new TypeError('status must be a string');
  if (!MEETING_STATUSES.includes(value)) throw new RangeError(`meeting status is not supported: ${value}`);
  return value;
}

function assertMeetingSegmentStatus(value) {
  if (typeof value !== 'string') throw new TypeError('status must be a string');
  if (!MEETING_SEGMENT_STATUSES.includes(value)) throw new RangeError(`meeting segment status is not supported: ${value}`);
  return value;
}

function assertInputObject(value, field) {
  if (!isRecord(value)) {
    throw new TypeError(`${field} must be an object`);
  }
}

function assertRequiredString(value, field) {
  if (typeof value !== 'string') {
    throw new TypeError(`${field} must be a string`);
  }

  if (value.trim().length === 0) {
    throw new RangeError(`${field} must not be empty`);
  }

  return value;
}

function assertOptionalString(value, field) {
  if (value === undefined || value === null) {
    return undefined;
  }

  return assertRequiredString(value, field);
}

function assertRequiredValue(value, field) {
  if (value === null || value === undefined) {
    throw new TypeError(`${field} is required`);
  }

  return value;
}

function assertTimestamp(value, field) {
  assertRequiredValue(value, field);

  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new TypeError(`${field} must be a string or number timestamp`);
  }

  if (typeof value === 'string' && value.trim().length === 0) {
    throw new RangeError(`${field} must not be empty`);
  }

  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new RangeError(`${field} must be finite`);
  }

  return value;
}

function assertNonNegativeInteger(value, field) {
  if (!Number.isInteger(value)) {
    throw new TypeError(`${field} must be an integer`);
  }

  if (value < 0) {
    throw new RangeError(`${field} must be non-negative`);
  }

  return value;
}

function deepClone(value) {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(deepClone);
  }

  if (!isPlainObject(value)) {
    throw new TypeError('nested domain values must be plain objects, arrays, or primitives');
  }

  const copy = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    copy[key] = deepClone(nestedValue);
  }
  return copy;
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }

  for (const nestedValue of Object.values(value)) {
    deepFreeze(nestedValue);
  }

  return Object.freeze(value);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPlainObject(value) {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
