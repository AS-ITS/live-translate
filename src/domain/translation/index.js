export {
  TRANSLATION_EVENT_TYPES,
  createTranslationExecutionCreatedEvent,
  createTranslationExecutionUpdatedEvent,
  createTranslationOutputCreatedEvent,
  createTranslationRequestCreatedEvent
} from './events.js';

export const TRANSLATION_EXECUTION_STATUSES = Object.freeze(['created', 'queued', 'running', 'completed', 'failed', 'cancelled']);
export const PROVIDER_ATTEMPT_STATUSES = Object.freeze(['not_started', 'in_flight', 'succeeded', 'failed']);
const PROVIDER_IDEMPOTENCY_KEY_PREFIX = 'translation-execution:';

const TERMINAL_EXECUTION_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const ALLOWED_EXECUTION_TRANSITIONS = Object.freeze({
  created: Object.freeze(['queued', 'running', 'failed']),
  queued: Object.freeze(['running', 'failed', 'cancelled']),
  running: Object.freeze(['queued', 'completed', 'failed']),
  completed: Object.freeze([]),
  failed: Object.freeze([]),
  cancelled: Object.freeze([])
});
const ALLOWED_PROVIDER_ATTEMPT_TRANSITIONS = Object.freeze({
  not_started: Object.freeze(['in_flight']),
  in_flight: Object.freeze(['in_flight', 'succeeded', 'failed']),
  succeeded: Object.freeze([]),
  failed: Object.freeze(['in_flight'])
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
    this.status = assertExecutionStatus(input.status ?? 'created');
    this.providerKey = assertOptionalString(input.providerKey, 'providerKey');
    Object.defineProperty(this, 'providerIdempotencyKey', {
      value: assertProviderIdempotencyKey(input.providerIdempotencyKey ?? createProviderIdempotencyKey(this.id), this.id),
      enumerable: false,
      writable: false,
      configurable: false
    });
    Object.defineProperty(this, 'providerAttemptStatus', {
      value: assertProviderAttemptStatus(input.providerAttemptStatus ?? 'not_started'),
      enumerable: false,
      writable: false,
      configurable: false
    });
    Object.defineProperty(this, 'providerAttemptedAt', {
      value: input.providerAttemptedAt ?? null,
      enumerable: false,
      writable: false,
      configurable: false
    });
    Object.defineProperty(this, 'providerCompletedAt', {
      value: input.providerCompletedAt ?? null,
      enumerable: false,
      writable: false,
      configurable: false
    });
    Object.defineProperty(this, 'providerResult', {
      value: deepClone(input.providerResult ?? null),
      enumerable: false,
      writable: false,
      configurable: false
    });
    this.startedAt = assertTimestamp(input.startedAt, 'startedAt');
    this.completedAt = input.completedAt ?? null;
    this.failureInfo = deepClone(input.failureInfo ?? null);

    validateExecutionState(this);
    deepFreeze(this);
  }

  queue() {
    return this.transitionTo('queued');
  }

  start(startedAt = this.startedAt) {
    return this.transitionTo('running', { startedAt: assertTimestamp(startedAt, 'startedAt') });
  }

  resumeAfterExpiredLease() {
    return this.transitionTo('queued');
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

  // A manual retry must create a new execution; this source execution is never rewritten.
  isManualRetryEligible() {
    return this.status === 'failed';
  }

  markProviderAttemptInFlight(providerAttemptedAt) {
    return this.transitionProviderAttempt('in_flight', {
      providerAttemptedAt: assertTimestamp(providerAttemptedAt, 'providerAttemptedAt'),
      providerCompletedAt: null
    });
  }

  markProviderAttemptSucceeded(providerCompletedAt, providerResult) {
    return this.transitionProviderAttempt('succeeded', {
      providerCompletedAt: assertTimestamp(providerCompletedAt, 'providerCompletedAt'),
      providerResult: normalizeProviderResult(providerResult)
    });
  }

  markProviderAttemptFailed(providerCompletedAt) {
    return this.transitionProviderAttempt('failed', {
      providerCompletedAt: assertTimestamp(providerCompletedAt, 'providerCompletedAt')
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
      providerIdempotencyKey: this.providerIdempotencyKey,
      providerAttemptStatus: this.providerAttemptStatus,
      providerAttemptedAt: this.providerAttemptedAt,
      providerCompletedAt: this.providerCompletedAt,
      providerResult: this.providerResult,
      startedAt: patch.startedAt ?? this.startedAt,
      completedAt: patch.completedAt ?? null,
      failureInfo: patch.failureInfo ?? null
    });
  }

  transitionProviderAttempt(nextStatus, patch = {}) {
    const providerAttemptStatus = assertProviderAttemptStatus(nextStatus);

    if (!ALLOWED_PROVIDER_ATTEMPT_TRANSITIONS[this.providerAttemptStatus].includes(providerAttemptStatus)) {
      throw new RangeError(`provider attempt transition from ${this.providerAttemptStatus} to ${providerAttemptStatus} is not allowed`);
    }

    return new TranslationExecution({
      id: this.id,
      translationRequestId: this.translationRequestId,
      status: this.status,
      providerKey: this.providerKey,
      providerIdempotencyKey: this.providerIdempotencyKey,
      providerAttemptStatus,
      providerAttemptedAt: Object.hasOwn(patch, 'providerAttemptedAt')
        ? patch.providerAttemptedAt
        : this.providerAttemptedAt,
      providerCompletedAt: Object.hasOwn(patch, 'providerCompletedAt')
        ? patch.providerCompletedAt
        : this.providerCompletedAt,
      providerResult: Object.hasOwn(patch, 'providerResult') ? patch.providerResult : this.providerResult,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      failureInfo: this.failureInfo
    });
  }
}

export function createProviderIdempotencyKey(executionId) {
  return `${PROVIDER_IDEMPOTENCY_KEY_PREFIX}${assertRequiredString(executionId, 'id')}`;
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
    this.sessionId = assertOptionalString(input.sessionId, 'sessionId');
    this.requestId = assertOptionalString(input.requestId, 'requestId');
    this.sourceText = input.sourceText === undefined ? undefined : assertRequiredString(input.sourceText, 'sourceText');
    this.sourceLanguageCode = assertOptionalString(input.sourceLanguageCode, 'sourceLanguageCode');
    this.sourceLanguageMetadata = deepClone(input.sourceLanguageMetadata ?? null);
    this.sourceTranscriptMetadata = deepClone(input.sourceTranscriptMetadata ?? null);
    this.detectedSourceLanguageCode = assertOptionalString(input.detectedSourceLanguageCode, 'detectedSourceLanguageCode');
    this.version = input.version === undefined ? undefined : assertPositiveInteger(input.version, 'version');
    this.completedAt = input.completedAt === undefined ? this.createdAt : assertTimestamp(input.completedAt, 'completedAt');

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

  validateProviderAttemptState(execution);
}

function validateProviderAttemptState(execution) {
  if (execution.providerAttemptStatus === 'not_started') {
    if (execution.providerAttemptedAt !== null || execution.providerCompletedAt !== null || execution.providerResult !== null) {
      throw new RangeError('provider attempt timestamps are not allowed before provider execution');
    }
    return;
  }

  assertTimestamp(execution.providerAttemptedAt, 'providerAttemptedAt');

  if (execution.providerAttemptStatus === 'in_flight') {
    if (execution.providerCompletedAt !== null || execution.providerResult !== null) {
      throw new RangeError('providerCompletedAt is not allowed for in_flight provider attempt');
    }
    return;
  }

  assertTimestamp(execution.providerCompletedAt, 'providerCompletedAt');

  if (execution.providerAttemptStatus === 'succeeded') {
    normalizeProviderResult(execution.providerResult);
  } else if (execution.providerResult !== null) {
    throw new RangeError('providerResult is not allowed for failed provider attempt');
  }
}

function normalizeProviderResult(value) {
  if (!isRecord(value)) {
    throw new TypeError('providerResult must be an object');
  }

  const translatedText = assertRequiredString(value.translatedText, 'providerResult.translatedText');
  const result = { translatedText };
  if (value.detectedSourceLanguageCode !== undefined) {
    result.detectedSourceLanguageCode = assertRequiredString(
      value.detectedSourceLanguageCode,
      'providerResult.detectedSourceLanguageCode'
    );
  }
  return deepClone(result);
}

function assertPositiveInteger(value, field) {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${field} must be a positive integer`);
  return value;
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

function assertProviderAttemptStatus(value) {
  if (typeof value !== 'string') {
    throw new TypeError('providerAttemptStatus must be a string');
  }

  if (!PROVIDER_ATTEMPT_STATUSES.includes(value)) {
    throw new RangeError(`providerAttemptStatus is not supported: ${value}`);
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

function assertProviderIdempotencyKey(value, executionId) {
  const providerIdempotencyKey = assertRequiredString(value, 'providerIdempotencyKey');
  const expectedKey = createProviderIdempotencyKey(executionId);

  if (providerIdempotencyKey !== expectedKey) {
    throw new RangeError(`providerIdempotencyKey must match execution id: ${executionId}`);
  }

  return providerIdempotencyKey;
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
