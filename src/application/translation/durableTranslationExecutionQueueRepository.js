import { INVALID_TRANSLATION_EXECUTION_QUEUE_ITEM_CODE } from './translationExecutionQueue.js';

const INVALID_REPOSITORY_MESSAGE = 'durableTranslationExecutionQueueRepository implementation is required.';
const REQUIRED_METHODS = Object.freeze([
  'enqueue',
  'dequeue',
  'peek',
  'list',
  'size',
  'clear',
  'updateStatus',
  'acknowledge',
  'contains',
  'claim',
  'requeueExpiredProcessing'
]);
const INVALID_ITEM_MESSAGE = 'Durable translation execution queue item must be an object.';
const INVALID_EXECUTION_ID_MESSAGE =
  'Durable translation execution queue item executionId must be a non-empty string.';
const INVALID_REQUEST_ID_MESSAGE = 'Durable translation execution queue item requestId must be a non-empty string.';
const INVALID_ENQUEUED_AT_MESSAGE = 'Durable translation execution queue item enqueuedAt must be an ISO-8601 UTC string.';
const INVALID_STATUS_MESSAGE = 'Durable translation execution queue item status is not supported.';

export const TRANSLATION_EXECUTION_QUEUE_ITEM_CONFLICT_CODE = 'translation_execution_queue_item_conflict';
export const TRANSLATION_EXECUTION_QUEUE_ITEM_NOT_FOUND_CODE = 'translation_execution_queue_item_not_found';
export const DURABLE_TRANSLATION_EXECUTION_QUEUE_ITEM_IDENTITY = Object.freeze({
  SAME: 'same',
  CONFLICT: 'conflict',
  DISTINCT: 'distinct'
});

export const DURABLE_TRANSLATION_EXECUTION_QUEUE_ITEM_STATUSES = Object.freeze({
  QUEUED: 'queued',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed'
});

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

    async list() {
      return immutableQueueItems(await implementation.list());
    },

    async size() {
      return implementation.size();
    },

    async clear() {
      return implementation.clear();
    },

    async updateStatus(executionId, status) {
      assertNonEmptyString(executionId, INVALID_EXECUTION_ID_MESSAGE);
      assertDurableTranslationExecutionQueueItemStatus(status);
      return implementation.updateStatus(executionId, status);
    },

    async acknowledge(executionId) {
      assertNonEmptyString(executionId, INVALID_EXECUTION_ID_MESSAGE);
      return createDurableTranslationExecutionQueueItem(await implementation.acknowledge(executionId));
    },

    async contains(executionId) {
      assertNonEmptyString(executionId, INVALID_EXECUTION_ID_MESSAGE);
      return implementation.contains(executionId);
    },

    async claim(executionId, lease) {
      assertNonEmptyString(executionId, INVALID_EXECUTION_ID_MESSAGE);
      assertDurableTranslationExecutionQueueLease(lease);
      return implementation.claim(executionId, lease);
    },

    async requeueExpiredProcessing(executionId, now) {
      assertNonEmptyString(executionId, INVALID_EXECUTION_ID_MESSAGE);
      assertIsoUtcString(now, 'Durable translation execution queue recovery time must be an ISO-8601 UTC string.');
      return immutableQueueItemOrNull(await implementation.requeueExpiredProcessing(executionId, now));
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

  assertDurableTranslationExecutionQueueItemIdentity(item);
  assertIsoUtcString(item.enqueuedAt, INVALID_ENQUEUED_AT_MESSAGE);

  assertDurableTranslationExecutionQueueItemState(item);
}

export function assertDurableTranslationExecutionQueueItemIdentity(item) {
  if (!isRecord(item)) {
    throwInvalidQueueItem(INVALID_ITEM_MESSAGE);
  }

  assertNonEmptyString(item.executionId, INVALID_EXECUTION_ID_MESSAGE);
  assertNonEmptyString(item.requestId, INVALID_REQUEST_ID_MESSAGE);
}

export function compareDurableTranslationExecutionQueueItemIdentity(existingItem, candidateItem) {
  assertDurableTranslationExecutionQueueItemIdentity(existingItem);
  assertDurableTranslationExecutionQueueItemIdentity(candidateItem);

  if (existingItem.executionId !== candidateItem.executionId) {
    return DURABLE_TRANSLATION_EXECUTION_QUEUE_ITEM_IDENTITY.DISTINCT;
  }

  return existingItem.requestId === candidateItem.requestId
    ? DURABLE_TRANSLATION_EXECUTION_QUEUE_ITEM_IDENTITY.SAME
    : DURABLE_TRANSLATION_EXECUTION_QUEUE_ITEM_IDENTITY.CONFLICT;
}

export function createTranslationExecutionQueueItemConflictError() {
  const error = new Error('Translation execution queue item conflict.');
  error.code = TRANSLATION_EXECUTION_QUEUE_ITEM_CONFLICT_CODE;
  return error;
}

export function createTranslationExecutionQueueItemNotFoundError(executionId) {
  const error = new Error(`Durable translation execution queue item ${executionId} was not found`);
  error.code = TRANSLATION_EXECUTION_QUEUE_ITEM_NOT_FOUND_CODE;
  return error;
}

export function createDurableTranslationExecutionQueueItemNotClaimableError() {
  const error = new TypeError('Durable translation execution queue item must be queued before it can be claimed.');
  error.code = INVALID_TRANSLATION_EXECUTION_QUEUE_ITEM_CODE;
  return error;
}

export function createDurableTranslationExecutionQueueItem(item) {
  assertDurableTranslationExecutionQueueItem(item);

  return createNormalizedDurableTranslationExecutionQueueItem(item);
}

export function normalizeDurableTranslationExecutionQueueItem(item) {
  if (!isRecord(item)) {
    throwInvalidQueueItem(INVALID_ITEM_MESSAGE);
  }

  assertDurableTranslationExecutionQueueItemIdentity(item);
  assertIsoUtcString(item.enqueuedAt, INVALID_ENQUEUED_AT_MESSAGE);

  const status = Object.hasOwn(item, 'status')
    ? item.status
    : DURABLE_TRANSLATION_EXECUTION_QUEUE_ITEM_STATUSES.QUEUED;
  assertDurableTranslationExecutionQueueItemStatus(status);

  if (status !== DURABLE_TRANSLATION_EXECUTION_QUEUE_ITEM_STATUSES.PROCESSING) {
    assertNoLeaseMetadata(item);
  } else if (hasAnyLeaseMetadata(item)) {
    assertDurableTranslationExecutionQueueLease(item);
  }

  return createNormalizedDurableTranslationExecutionQueueItem({ ...item, status });
}

export function assertDurableTranslationExecutionQueueLease(lease) {
  if (!isRecord(lease)) {
    throwInvalidQueueItem('Durable translation execution queue lease must be an object.');
  }

  assertNonEmptyString(lease.leaseId, 'Durable translation execution queue item leaseId must be a non-empty string.');
  assertIsoUtcString(lease.claimedAt, 'Durable translation execution queue item claimedAt must be an ISO-8601 UTC string.');
  assertIsoUtcString(lease.leaseExpiresAt, 'Durable translation execution queue item leaseExpiresAt must be an ISO-8601 UTC string.');

  if (lease.claimedAt >= lease.leaseExpiresAt) {
    throwInvalidQueueItem('Durable translation execution queue item leaseExpiresAt must be after claimedAt.');
  }
}

function createNormalizedDurableTranslationExecutionQueueItem(item) {
  const normalized = {
    executionId: item.executionId,
    requestId: item.requestId,
    enqueuedAt: item.enqueuedAt,
    status: Object.hasOwn(item, 'status')
      ? item.status
      : DURABLE_TRANSLATION_EXECUTION_QUEUE_ITEM_STATUSES.QUEUED
  };

  if (item.status === DURABLE_TRANSLATION_EXECUTION_QUEUE_ITEM_STATUSES.PROCESSING
    && hasAnyLeaseMetadata(item)) {
    normalized.leaseId = item.leaseId;
    normalized.claimedAt = item.claimedAt;
    normalized.leaseExpiresAt = item.leaseExpiresAt;
  }

  return Object.freeze(normalized);
}

export function assertDurableTranslationExecutionQueueItemStatus(status) {
  if (!Object.values(DURABLE_TRANSLATION_EXECUTION_QUEUE_ITEM_STATUSES).includes(status)) {
    throwInvalidQueueItem(INVALID_STATUS_MESSAGE);
  }
}

function immutableQueueItemOrNull(item) {
  if (item === null || item === undefined) {
    return null;
  }

  return normalizeDurableTranslationExecutionQueueItem(item);
}

function immutableQueueItems(items) {
  if (!Array.isArray(items)) {
    throw new TypeError('durableTranslationExecutionQueueRepository.list must return an array.');
  }

  return Object.freeze(items.map((item) => normalizeDurableTranslationExecutionQueueItem(item)));
}

function assertDurableTranslationExecutionQueueItemState(item) {
  const status = Object.hasOwn(item, 'status')
    ? item.status
    : DURABLE_TRANSLATION_EXECUTION_QUEUE_ITEM_STATUSES.QUEUED;
  assertDurableTranslationExecutionQueueItemStatus(status);

  if (status === DURABLE_TRANSLATION_EXECUTION_QUEUE_ITEM_STATUSES.PROCESSING) {
    assertDurableTranslationExecutionQueueLease(item);
    return;
  }

  assertNoLeaseMetadata(item);
}

function assertNoLeaseMetadata(item) {
  if (hasAnyLeaseMetadata(item)) {
    throwInvalidQueueItem('Durable translation execution queue item lease metadata is only valid while processing.');
  }
}

function hasAnyLeaseMetadata(item) {
  return Object.hasOwn(item, 'leaseId')
    || Object.hasOwn(item, 'claimedAt')
    || Object.hasOwn(item, 'leaseExpiresAt');
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
