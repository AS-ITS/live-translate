const INVALID_QUEUE_IMPLEMENTATION_MESSAGE = 'translationExecutionQueue implementation is required.';
const INVALID_ENQUEUE_MESSAGE = 'translationExecutionQueue.enqueue must be a function.';
const INVALID_DEQUEUE_MESSAGE = 'translationExecutionQueue.dequeue must be a function.';
const INVALID_SIZE_MESSAGE = 'translationExecutionQueue.size must be a function.';
const INVALID_JOB_MESSAGE = 'Translation execution queue job must be an object.';
const INVALID_EXECUTION_ID_MESSAGE = 'Translation execution queue job executionId must be a non-empty string.';
const INVALID_REQUEST_ID_MESSAGE = 'Translation execution queue job requestId must be a non-empty string.';
export const INVALID_TRANSLATION_EXECUTION_QUEUE_ITEM_CODE = 'invalid_translation_execution_queue_item';

export function createTranslationExecutionQueue(implementation = {}) {
  assertQueueImplementation(implementation);

  return Object.freeze({
    enqueue(job) {
      assertTranslationExecutionQueueJob(job);
      return implementation.enqueue(job);
    },

    dequeue() {
      return implementation.dequeue() ?? null;
    },

    size() {
      return implementation.size();
    }
  });
}

export function assertTranslationExecutionQueueJob(job) {
  if (!isRecord(job)) {
    throwInvalidQueueItem(INVALID_JOB_MESSAGE);
  }

  assertNonEmptyString(job.executionId, INVALID_EXECUTION_ID_MESSAGE);
  assertNonEmptyString(job.requestId, INVALID_REQUEST_ID_MESSAGE);
}

export function assertTranslationExecutionQueue(implementation) {
  assertQueueImplementation(implementation);
}

function assertQueueImplementation(implementation) {
  if (!isRecord(implementation)) {
    throw new TypeError(INVALID_QUEUE_IMPLEMENTATION_MESSAGE);
  }

  if (typeof implementation.enqueue !== 'function') {
    throw new TypeError(INVALID_ENQUEUE_MESSAGE);
  }

  if (typeof implementation.dequeue !== 'function') {
    throw new TypeError(INVALID_DEQUEUE_MESSAGE);
  }

  if (typeof implementation.size !== 'function') {
    throw new TypeError(INVALID_SIZE_MESSAGE);
  }
}

function assertNonEmptyString(value, message) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throwInvalidQueueItem(message);
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function throwInvalidQueueItem(message) {
  const error = new TypeError(message);
  error.code = INVALID_TRANSLATION_EXECUTION_QUEUE_ITEM_CODE;
  throw error;
}
