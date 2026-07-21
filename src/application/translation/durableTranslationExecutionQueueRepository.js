import { INVALID_TRANSLATION_EXECUTION_QUEUE_ITEM_CODE } from './translationExecutionQueue.js';

const INVALID_REPOSITORY_MESSAGE = 'durableTranslationExecutionQueueRepository implementation is required.';
const REQUIRED_METHODS = Object.freeze([
  'enqueue',
  'dequeue',
  'peek',
  'list',
  'listAvailable',
  'nextAvailableAt',
  'size',
  'clear',
  'updateStatus',
  'acknowledge',
  'acknowledgeClaim',
  'contains',
  'claim',
  'retryClaim',
  'renewClaim',
  'assertClaimActive',
  'requeueExpiredProcessing'
]);
const INVALID_ITEM_MESSAGE = 'Durable translation execution queue item must be an object.';
const INVALID_EXECUTION_ID_MESSAGE =
  'Durable translation execution queue item executionId must be a non-empty string.';
const INVALID_REQUEST_ID_MESSAGE = 'Durable translation execution queue item requestId must be a non-empty string.';
const INVALID_ENQUEUED_AT_MESSAGE = 'Durable translation execution queue item enqueuedAt must be an ISO-8601 UTC string.';
const INVALID_STATUS_MESSAGE = 'Durable translation execution queue item status is not supported.';
const INVALID_FENCE_TOKEN_MESSAGE = 'Durable translation execution queue item fenceToken must be a non-negative integer.';
const INVALID_ATTEMPT_MESSAGE = 'Durable translation execution queue item attempt must be a non-negative integer.';
const INVALID_AVAILABLE_AT_MESSAGE = 'Durable translation execution queue item availableAt must be null or an ISO-8601 UTC string.';
const INVALID_LAST_FAILURE_MESSAGE = 'Durable translation execution queue item lastFailure must be null or an object.';

export const TRANSLATION_EXECUTION_QUEUE_ITEM_CONFLICT_CODE = 'translation_execution_queue_item_conflict';
export const TRANSLATION_EXECUTION_QUEUE_ITEM_NOT_FOUND_CODE = 'translation_execution_queue_item_not_found';
export const TRANSLATION_EXECUTION_QUEUE_LEASE_OWNERSHIP_CODE = 'translation_execution_queue_lease_ownership_error';
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

    async listAvailable(now) {
      assertIsoUtcString(now, 'Durable translation execution queue availability time must be an ISO-8601 UTC string.');
      return immutableQueueItems(await implementation.listAvailable(now));
    },

    async nextAvailableAt(now) {
      assertIsoUtcString(now, 'Durable translation execution queue availability time must be an ISO-8601 UTC string.');
      const availableAt = await implementation.nextAvailableAt(now);
      if (availableAt !== null && availableAt !== undefined) {
        assertIsoUtcString(availableAt, 'durableTranslationExecutionQueueRepository.nextAvailableAt must return an ISO-8601 UTC string or null.');
      }
      return availableAt ?? null;
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

    async acknowledgeClaim(executionId, claim) {
      assertNonEmptyString(executionId, INVALID_EXECUTION_ID_MESSAGE);
      assertDurableTranslationExecutionQueueFenceClaim(claim);
      return createDurableTranslationExecutionQueueItem(await implementation.acknowledgeClaim(executionId, claim));
    },

    async transferClaimToDeadLetter(executionId, transfer) {
      assertNonEmptyString(executionId, INVALID_EXECUTION_ID_MESSAGE);
      assertDurableTranslationExecutionQueueDeadLetterTransfer(transfer);
      if (typeof implementation.transferClaimToDeadLetter !== 'function') {
        throw new TypeError('durableTranslationExecutionQueueRepository.transferClaimToDeadLetter must be a function.');
      }
      return createDurableTranslationExecutionQueueItem(await implementation.transferClaimToDeadLetter(executionId, transfer));
    },

    async contains(executionId) {
      assertNonEmptyString(executionId, INVALID_EXECUTION_ID_MESSAGE);
      return implementation.contains(executionId);
    },

    async claim(executionId, lease) {
      assertNonEmptyString(executionId, INVALID_EXECUTION_ID_MESSAGE);
      assertDurableTranslationExecutionQueueLease(lease);
      return createDurableTranslationExecutionQueueItem(await implementation.claim(executionId, lease));
    },

    async retryClaim(executionId, retry) {
      assertNonEmptyString(executionId, INVALID_EXECUTION_ID_MESSAGE);
      assertDurableTranslationExecutionQueueRetryClaim(retry);
      return createDurableTranslationExecutionQueueItem(await implementation.retryClaim(executionId, retry));
    },

    async renewClaim(executionId, claim, lease) {
      assertNonEmptyString(executionId, INVALID_EXECUTION_ID_MESSAGE);
      assertDurableTranslationExecutionQueueLeaseOwnership(claim);
      assertDurableTranslationExecutionQueueRenewalLease(lease);
      return createDurableTranslationExecutionQueueItem(await implementation.renewClaim(executionId, claim, lease));
    },

    async assertClaimActive(executionId, claim, now) {
      assertNonEmptyString(executionId, INVALID_EXECUTION_ID_MESSAGE);
      assertDurableTranslationExecutionQueueActiveClaim(claim);
      assertIsoUtcString(now, 'Durable translation execution queue assertion time must be an ISO-8601 UTC string.');
      return createDurableTranslationExecutionQueueItem(await implementation.assertClaimActive(executionId, claim, now));
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
  assertDurableTranslationExecutionQueueFenceToken(
    Object.hasOwn(item, 'fenceToken') ? item.fenceToken : 0
  );
  assertDurableTranslationExecutionQueueRetryMetadata(item);

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

export function createDurableTranslationExecutionQueueLeaseOwnershipError() {
  const error = new TypeError('Durable translation execution queue item lease ownership does not match.');
  error.code = TRANSLATION_EXECUTION_QUEUE_LEASE_OWNERSHIP_CODE;
  return error;
}

export function createDurableTranslationExecutionQueueItem(item) {
  return normalizeDurableTranslationExecutionQueueItem(item);
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

  const fenceToken = Object.hasOwn(item, 'fenceToken') ? item.fenceToken : 0;
  assertDurableTranslationExecutionQueueFenceToken(fenceToken);
  assertDurableTranslationExecutionQueueRetryMetadata(item);

  if (status === DURABLE_TRANSLATION_EXECUTION_QUEUE_ITEM_STATUSES.PROCESSING) {
    assertDurableTranslationExecutionQueueLease(item);
  } else {
    assertNoLeaseMetadata(item);
  }

  return createNormalizedDurableTranslationExecutionQueueItem({
    ...item,
    status,
    fenceToken,
    attempt: Object.hasOwn(item, 'attempt') ? item.attempt : 0,
    availableAt: Object.hasOwn(item, 'availableAt') ? item.availableAt : null,
    lastFailure: Object.hasOwn(item, 'lastFailure') ? item.lastFailure : null
  });
}

export function assertDurableTranslationExecutionQueueRetryMetadata(item) {
  const attempt = Object.hasOwn(item, 'attempt') ? item.attempt : 0;
  if (!Number.isInteger(attempt) || attempt < 0) {
    throwInvalidQueueItem(INVALID_ATTEMPT_MESSAGE);
  }

  const availableAt = Object.hasOwn(item, 'availableAt') ? item.availableAt : null;
  if (availableAt !== null && (typeof availableAt !== 'string' || !isIsoUtcString(availableAt))) {
    throwInvalidQueueItem(INVALID_AVAILABLE_AT_MESSAGE);
  }

  const lastFailure = Object.hasOwn(item, 'lastFailure') ? item.lastFailure : null;
  if (lastFailure !== null && !isRecord(lastFailure)) {
    throwInvalidQueueItem(INVALID_LAST_FAILURE_MESSAGE);
  }
}

export function assertDurableTranslationExecutionQueueRetryClaim(retry) {
  if (!isRecord(retry)) throwInvalidQueueItem('Durable translation execution queue retry claim must be an object.');
  assertDurableTranslationExecutionQueueFenceClaim(retry);
  if (!Number.isInteger(retry.attempt) || retry.attempt < 1) {
    throwInvalidQueueItem('Durable translation execution queue retry attempt must be a positive integer.');
  }
  assertIsoUtcString(retry.availableAt, 'Durable translation execution queue retry availableAt must be an ISO-8601 UTC string.');
  if (!isRecord(retry.lastFailure)) {
    throwInvalidQueueItem('Durable translation execution queue retry lastFailure must be an object.');
  }
}

export function assertDurableTranslationExecutionQueueDeadLetterTransfer(transfer) {
  if (!isRecord(transfer)) throwInvalidQueueItem('Durable translation execution queue dead-letter transfer must be an object.');
  assertDurableTranslationExecutionQueueFenceClaim(transfer);
  assertIsoUtcString(transfer.failedAt, 'Durable translation execution queue dead-letter failedAt must be an ISO-8601 UTC string.');
  if (!isRecord(transfer.failure)) throwInvalidQueueItem('Durable translation execution queue dead-letter failure must be an object.');
  for (const field of ['providerMetadata', 'executionMetadata']) {
    if (Object.hasOwn(transfer, field) && !isRecord(transfer[field])) throwInvalidQueueItem(`Durable translation execution queue dead-letter ${field} must be an object when provided.`);
  }
  if (Object.hasOwn(transfer, 'providerKey')) assertNonEmptyString(transfer.providerKey, 'Durable translation execution queue dead-letter providerKey must be a non-empty string.');
}

export function assertDurableTranslationExecutionQueueLease(lease) {
  if (!isRecord(lease)) {
    throwInvalidQueueItem('Durable translation execution queue lease must be an object.');
  }

  assertNonEmptyString(lease.leaseId, 'Durable translation execution queue item leaseId must be a non-empty string.');
  assertIsoUtcString(lease.leaseExpiresAt, 'Durable translation execution queue item leaseExpiresAt must be an ISO-8601 UTC string.');
}

export function assertDurableTranslationExecutionQueueLeaseOwnership(claim) {
  if (!isRecord(claim)) {
    throwInvalidQueueItem('Durable translation execution queue acknowledgement claim must be an object.');
  }

  assertNonEmptyString(claim.leaseId, 'Durable translation execution queue item leaseId must be a non-empty string.');
}

export function assertDurableTranslationExecutionQueueActiveClaim(claim) {
  assertDurableTranslationExecutionQueueFenceClaim(claim);
}

export function assertDurableTranslationExecutionQueueFenceClaim(claim) {
  assertDurableTranslationExecutionQueueLeaseOwnership(claim);
  assertDurableTranslationExecutionQueueFenceToken(claim.fenceToken);
}

export function assertDurableTranslationExecutionQueueFenceToken(fenceToken) {
  if (!Number.isInteger(fenceToken) || fenceToken < 0) {
    throwInvalidQueueItem(INVALID_FENCE_TOKEN_MESSAGE);
  }
}

export function assertDurableTranslationExecutionQueueRenewalLease(lease) {
  if (!isRecord(lease)) {
    throwInvalidQueueItem('Durable translation execution queue renewal lease must be an object.');
  }

  const renewalFields = ['leaseExpiresAt', 'now'];
  if (Object.keys(lease).some((field) => !renewalFields.includes(field))) {
    throwInvalidQueueItem('Durable translation execution queue renewal lease may only contain leaseExpiresAt and now.');
  }

  assertIsoUtcString(lease.leaseExpiresAt, 'Durable translation execution queue renewal leaseExpiresAt must be an ISO-8601 UTC string.');
  assertIsoUtcString(lease.now, 'Durable translation execution queue renewal time must be an ISO-8601 UTC string.');
  if (lease.leaseExpiresAt <= lease.now) {
    throwInvalidQueueItem('Durable translation execution queue renewal leaseExpiresAt must be later than now.');
  }
}

function createNormalizedDurableTranslationExecutionQueueItem(item) {
  const normalized = {
    executionId: item.executionId,
    requestId: item.requestId,
    enqueuedAt: item.enqueuedAt,
    status: Object.hasOwn(item, 'status')
      ? item.status
      : DURABLE_TRANSLATION_EXECUTION_QUEUE_ITEM_STATUSES.QUEUED,
    fenceToken: Object.hasOwn(item, 'fenceToken') ? item.fenceToken : 0,
    attempt: Object.hasOwn(item, 'attempt') ? item.attempt : 0,
    availableAt: Object.hasOwn(item, 'availableAt') ? item.availableAt : null,
    lastFailure: item.lastFailure === null ? null : Object.freeze({ ...item.lastFailure })
  };

  if (item.status === DURABLE_TRANSLATION_EXECUTION_QUEUE_ITEM_STATUSES.PROCESSING
    && hasAnyLeaseMetadata(item)) {
    normalized.leaseId = item.leaseId;
    if (Object.hasOwn(item, 'claimedAt')) normalized.claimedAt = item.claimedAt;
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
