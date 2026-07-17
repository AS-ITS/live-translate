import { INVALID_TRANSLATION_EXECUTION_QUEUE_ITEM_CODE } from './translationExecutionQueue.js';

const INVALID_REPOSITORY_MESSAGE = 'durableTranslationExecutionQueueRepository implementation is required.';
const REQUIRED_METHODS = Object.freeze(['enqueue', 'dequeue', 'peek', 'size', 'clear']);
const INVALID_ITEM_MESSAGE = 'Durable translation execution queue item must be an object.';
const INVALID_EXECUTION_ID_MESSAGE =
  'Durable translation execution queue item executionId must be a non-empty string.';
const INVALID_REQUEST_ID_MESSAGE = 'Durable translation execution queue item requestId must be a non-empty string.';
const INVALID_ENQUEUED_AT_MESSAGE = 'Durable translation execution queue item enqueuedAt must be an ISO-8601 UTC string.';

export function createDurableTranslationExecutionQueueRepository(implementation = {}) {
  assertDurableTranslationExecutionQueueRepository(implementation);

  return Object.freeze({
    async enqueue(item) {
      assertDurableTranslationExecutionQueueItem(item);
      return implementation.enqueue(item);
    },

    async dequeue() {
      return immutableQueueItemOrNull(await implementation.dequeue());
    },

    async peek() {
      return immutableQueueItemOrNull(await implementation.peek());
    },

    async size() {
      return implementation.size();
    },

    async clear() {
      return implementation.clear();
    }
  });
}

export function assertDurableTranslationExecutionQueueRepository(implementation) {
  if (!isRecord(implementation)) {
    throw new TypeError(INVALID_REPOSITORY_MESSAGE);
  }

  for (const methodName of REQUIRED_METHODS) {
    if (typeof implementation[methodName] !== 'function') {
      throw new TypeError(`durableTranslationExecutionQueueRepository.${methodName} must be a function.`);
    }
  }
}

export function assertDurableTranslationExecutionQueueItem(item) {
  if (!isRecord(item)) {
    throwInvalidQueueItem(INVALID_ITEM_MESSAGE);
  }

  assertNonEmptyString(item.executionId, INVALID_EXECUTION_ID_MESSAGE);
  assertNonEmptyString(item.requestId, INVALID_REQUEST_ID_MESSAGE);
  assertIsoUtcString(item.enqueuedAt, INVALID_ENQUEUED_AT_MESSAGE);
}

export function createDurableTranslationExecutionQueueItem(item) {
  assertDurableTranslationExecutionQueueItem(item);

  return Object.freeze({
    executionId: item.executionId,
    requestId: item.requestId,
    enqueuedAt: item.enqueuedAt
  });
}

function immutableQueueItemOrNull(item) {
  if (item === null || item === undefined) {
    return null;
  }

  return createDurableTranslationExecutionQueueItem(item);
}

function assertNonEmptyString(value, message) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throwInvalidQueueItem(message);
  }
}

function assertIsoUtcString(value, message) {
  if (typeof value !== 'string' || !isIsoUtcString(value)) {
    throwInvalidQueueItem(message);
  }
}

function isIsoUtcString(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return false;
  }

  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function throwInvalidQueueItem(message) {
  const error = new TypeError(message);
  error.code = INVALID_TRANSLATION_EXECUTION_QUEUE_ITEM_CODE;
  throw error;
}
