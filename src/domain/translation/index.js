export {
  TRANSLATION_EVENT_TYPES,
  createTranslationExecutionCreatedEvent,
  createTranslationExecutionUpdatedEvent,
  createTranslationOutputCreatedEvent,
  createTranslationRequestCreatedEvent
} from './events.js';

export const TRANSLATION_EXECUTION_STATUSES = Object.freeze(['pending', 'running', 'completed', 'failed', 'cancelled']);

const TERMINAL_EXECUTION_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const ALLOWED_EXECUTION_TRANSITIONS = Object.freeze({
  pending: Object.freeze(['running', 'failed', 'cancelled']),
  running: Object.freeze(['completed', 'failed', 'cancelled']),
  completed: Object.freeze([]),
  failed: Object.freeze([]),
  cancelled: Object.freeze([])
});

export class TranslationRequest {
  constructor(input = {}) {
    assertInputObject(input, 'TranslationRequest input');

    this.id = assertRequiredString(input.id, 'id');
    this.sessionId = assertRequiredString(input.sessionId, 'sessionId');
    this.sourceTranscriptRevisionId = assertRequiredString(
      input.sourceTranscriptRevisionId,
      'sourceTranscriptRevisionId'
    );
    this.targetLanguageCode = assertRequiredString(input.targetLanguageCode, 'targetLanguageCode');
    this.sourceTranscriptSnapshot = deepClone(input.sourceTranscriptSnapshot ?? null);
    this.createdAt = assertTimestamp(input.createdAt, 'createdAt');

    deepFreeze(this);
  }
}

export class TranslationExecution {
  constructor(input = {}) {
    assertInputObject(input, 'TranslationExecution input');

    this.id = assertRequiredString(input.id, 'id');
    this.translationRequestId = assertRequiredString(input.translationRequestId, 'translationRequestId');
    this.status = assertExecutionStatus(input.status ?? 'pending');
    this.providerKey = assertOptionalString(input.providerKey, 'providerKey');
    this.startedAt = assertTimestamp(input.startedAt, 'startedAt');
    this.completedAt = input.completedAt ?? null;
    this.failureInfo = deepClone(input.failureInfo ?? null);

    validateExecutionState(this);
    deepFreeze(this);
  }

  start(startedAt = this.startedAt) {
    return this.transitionTo('running', { startedAt: assertTimestamp(startedAt, 'startedAt') });
  }

  complete(completedAt) {
    return this.transitionTo('completed', {
      completedAt: assertTimestamp(completedAt, 'completedAt'),
      failureInfo: null
    });
  }

  fail(failureInfo, completedAt) {
    return this.transitionTo('failed', {
      completedAt: assertTimestamp(completedAt, 'completedAt'),
      failureInfo: deepClone(assertRequiredValue(failureInfo, 'failureInfo'))
    });
  }

  cancel(completedAt) {
    return this.transitionTo('cancelled', {
      completedAt: assertTimestamp(completedAt, 'completedAt'),
      failureInfo: null
    });
  }

  transitionTo(status, patch = {}) {
    const nextStatus = assertExecutionStatus(status);

    if (!ALLOWED_EXECUTION_TRANSITIONS[this.status].includes(nextStatus)) {
      throw new RangeError(`status transition from ${this.status} to ${nextStatus} is not allowed`);
    }

    return new TranslationExecution({
      id: this.id,
      translationRequestId: this.translationRequestId,
      status: nextStatus,
      providerKey: this.providerKey,
      startedAt: patch.startedAt ?? this.startedAt,
      completedAt: patch.completedAt ?? null,
      failureInfo: patch.failureInfo ?? null
    });
  }
}

export class TranslationOutput {
  constructor(input = {}) {
    assertInputObject(input, 'TranslationOutput input');

    this.id = assertRequiredString(input.id, 'id');
    this.executionId = assertRequiredString(input.executionId, 'executionId');
    this.sequence = assertNonNegativeInteger(input.sequence, 'sequence');
    this.translatedText = assertRequiredString(input.translatedText, 'translatedText');
    this.targetLanguageCode = assertRequiredString(input.targetLanguageCode, 'targetLanguageCode');
    this.providerMetadata = deepClone(input.providerMetadata ?? null);
    this.providerMetadataAvailable = this.providerMetadata !== null;
    this.createdAt = assertTimestamp(input.createdAt, 'createdAt');

    deepFreeze(this);
  }
}

function validateExecutionState(execution) {
  if (TERMINAL_EXECUTION_STATUSES.has(execution.status) && execution.completedAt === null) {
    throw new RangeError(`completedAt is required for ${execution.status} execution`);
  }

  if (!TERMINAL_EXECUTION_STATUSES.has(execution.status) && execution.completedAt !== null) {
    throw new RangeError(`completedAt is not allowed for ${execution.status} execution`);
  }

  if (execution.status === 'failed' && execution.failureInfo === null) {
    throw new RangeError('failureInfo is required for failed execution');
  }

  if (execution.status !== 'failed' && execution.failureInfo !== null) {
    throw new RangeError(`failureInfo is not allowed for ${execution.status} execution`);
  }
}

function assertInputObject(value, field) {
  if (!isRecord(value)) {
    throw new TypeError(`${field} must be an object`);
  }
}

function assertExecutionStatus(value) {
  if (typeof value !== 'string') {
    throw new TypeError('status must be a string');
  }

  if (!TRANSLATION_EXECUTION_STATUSES.includes(value)) {
    throw new RangeError(`status is not supported: ${value}`);
  }

  return value;
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
  if (value === undefined) {
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
  if (!isRecord(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
