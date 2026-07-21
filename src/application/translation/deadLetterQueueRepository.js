const INVALID_REPOSITORY_MESSAGE = 'deadLetterQueueRepository implementation is required.';
const REQUIRED_METHODS = Object.freeze(['enqueue', 'list', 'size', 'clear']);
const INVALID_ITEM_MESSAGE = 'Dead-letter queue item must be an object.';
const INVALID_EXECUTION_ID_MESSAGE = 'Dead-letter queue item executionId must be a non-empty string.';
const INVALID_REQUEST_ID_MESSAGE = 'Dead-letter queue item requestId must be a non-empty string.';
const INVALID_ATTEMPT_MESSAGE = 'Dead-letter queue item attempt must be a non-negative integer.';
const INVALID_FAILED_AT_MESSAGE = 'Dead-letter queue item failedAt must be an ISO-8601 UTC string.';
const INVALID_FAILURE_MESSAGE = 'Dead-letter queue item failure must be an object.';

export function createDeadLetterQueueRepository(implementation = {}) {
  assertDeadLetterQueueRepository(implementation);

  return Object.freeze({
    async enqueue(item) {
      assertDeadLetterQueueItem(item);
      return implementation.enqueue(item);
    },

    async list() {
      const items = await implementation.list();
      if (!Array.isArray(items)) throw new TypeError('deadLetterQueueRepository.list must return an array.');
      return Object.freeze(items.map((item) => createDeadLetterQueueItem(item)));
    },

    async size() {
      return implementation.size();
    },

    async clear() {
      return implementation.clear();
    }
  });
}

export function assertDeadLetterQueueRepository(implementation) {
  if (!isRecord(implementation)) throw new TypeError(INVALID_REPOSITORY_MESSAGE);
  for (const methodName of REQUIRED_METHODS) {
    if (typeof implementation[methodName] !== 'function') {
      throw new TypeError(`deadLetterQueueRepository.${methodName} must be a function.`);
    }
  }
}

export function assertDeadLetterQueueItem(item) {
  if (!isRecord(item)) throwInvalidItem(INVALID_ITEM_MESSAGE);
  assertNonEmptyString(item.executionId, INVALID_EXECUTION_ID_MESSAGE);
  assertNonEmptyString(item.requestId, INVALID_REQUEST_ID_MESSAGE);
  if (!Number.isInteger(item.attempt) || item.attempt < 0) throwInvalidItem(INVALID_ATTEMPT_MESSAGE);
  if (item.availableAt !== null && item.availableAt !== undefined && (typeof item.availableAt !== 'string' || !isIsoUtcString(item.availableAt))) throwInvalidItem('Dead-letter queue item availableAt must be null or an ISO-8601 UTC string.');
  if (item.lastFailure !== null && item.lastFailure !== undefined && !isRecord(item.lastFailure)) throwInvalidItem('Dead-letter queue item lastFailure must be null or an object.');
  if (typeof item.failedAt !== 'string' || !isIsoUtcString(item.failedAt)) throwInvalidItem(INVALID_FAILED_AT_MESSAGE);
  if (!isRecord(item.failure)) throwInvalidItem(INVALID_FAILURE_MESSAGE);
  if (Object.hasOwn(item, 'providerKey')) {
    assertNonEmptyString(item.providerKey, 'Dead-letter queue item providerKey must be a non-empty string.');
  }
  assertOptionalMetadata(item, 'providerMetadata');
  assertOptionalMetadata(item, 'executionMetadata');
}

export function createDeadLetterQueueItem(item) {
  assertDeadLetterQueueItem(item);
  const normalized = {
    executionId: item.executionId,
    requestId: item.requestId,
    attempt: item.attempt,
    availableAt: item.availableAt ?? null,
    lastFailure: item.lastFailure === null || item.lastFailure === undefined ? null : Object.freeze({ ...item.lastFailure }),
    failedAt: item.failedAt,
    failure: Object.freeze({ ...item.failure })
  };
  if (Object.hasOwn(item, 'providerKey')) normalized.providerKey = item.providerKey;
  if (Object.hasOwn(item, 'providerMetadata')) normalized.providerMetadata = Object.freeze({ ...item.providerMetadata });
  if (Object.hasOwn(item, 'executionMetadata')) normalized.executionMetadata = Object.freeze({ ...item.executionMetadata });
  return Object.freeze(normalized);
}

function assertOptionalMetadata(item, field) {
  if (Object.hasOwn(item, field) && !isRecord(item[field])) {
    throwInvalidItem(`Dead-letter queue item ${field} must be an object when provided.`);
  }
}

function assertNonEmptyString(value, message) {
  if (typeof value !== 'string' || value.trim().length === 0) throwInvalidItem(message);
}

function isIsoUtcString(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function throwInvalidItem(message) {
  const error = new TypeError(message);
  error.code = 'invalid_dead_letter_queue_item';
  throw error;
}
