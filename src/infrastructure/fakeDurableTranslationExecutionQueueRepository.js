import {
  compareDurableTranslationExecutionQueueItemIdentity,
  createTranslationExecutionQueueItemConflictError,
  createDurableTranslationExecutionQueueItemNotClaimableError,
  createDurableTranslationExecutionQueueLeaseOwnershipError,
  createTranslationExecutionQueueItemNotFoundError,
  createDurableTranslationExecutionQueueItem,
  createDurableTranslationExecutionQueueRepository,
  DURABLE_TRANSLATION_EXECUTION_QUEUE_ITEM_IDENTITY
} from '../application/translation/durableTranslationExecutionQueueRepository.js';
import { createFakeDeadLetterQueueRepository } from './fakeDeadLetterQueueRepository.js';

export function createFakeDurableTranslationExecutionQueueRepository({ deadLetterQueueRepository } = {}) {
  const items = [];
  const resolvedDeadLetterQueueRepository = deadLetterQueueRepository ?? createFakeDeadLetterQueueRepository();

  return createDurableTranslationExecutionQueueRepository({
    enqueue(item) {
      const existingItem = items.find((candidate) => candidate.executionId === item.executionId);
      if (existingItem === undefined) {
        items.push(createDurableTranslationExecutionQueueItem(item));
        return undefined;
      }

      if (compareDurableTranslationExecutionQueueItemIdentity(existingItem, item)
        === DURABLE_TRANSLATION_EXECUTION_QUEUE_ITEM_IDENTITY.CONFLICT) {
        throw createTranslationExecutionQueueItemConflictError();
      }

      return undefined;
    },

    dequeue() {
      return cloneQueueItemOrNull(items.shift());
    },

    peek() {
      return cloneQueueItemOrNull(items[0]);
    },

    list() {
      return items.map((item) => createDurableTranslationExecutionQueueItem(item));
    },

    listAvailable(now) {
      return items.filter((item) => item.status === 'queued' && (item.availableAt === null || item.availableAt <= now));
    },

    nextAvailableAt(now) {
      return items
        .filter((item) => item.status === 'queued' && item.availableAt !== null && item.availableAt > now)
        .map((item) => item.availableAt)
        .sort()[0] ?? null;
    },

    size() {
      return items.length;
    },

    clear() {
      items.length = 0;
      return undefined;
    },

    updateStatus(executionId, status) {
      const itemIndex = items.findIndex((item) => item.executionId === executionId);

      if (itemIndex === -1) {
        throw new Error(`Durable translation execution queue item ${executionId} was not found`);
      }

      items[itemIndex] = createUpdatedItem(items[itemIndex], status);
      return undefined;
    },

    acknowledge(executionId) {
      const itemIndex = items.findIndex((item) => item.executionId === executionId);

      if (itemIndex === -1) {
        throw createTranslationExecutionQueueItemNotFoundError(executionId);
      }

      return items.splice(itemIndex, 1)[0];
    },

    acknowledgeClaim(executionId, claim) {
      const itemIndex = items.findIndex((item) => item.executionId === executionId);
      if (itemIndex === -1) throw createTranslationExecutionQueueItemNotFoundError(executionId);
      const item = items[itemIndex];
      if (item.status !== 'processing') throw createDurableTranslationExecutionQueueItemNotClaimableError();
      if (item.leaseId !== claim.leaseId || item.fenceToken !== claim.fenceToken) {
        throw createDurableTranslationExecutionQueueLeaseOwnershipError();
      }
      return items.splice(itemIndex, 1)[0];
    },

    async transferClaimToDeadLetter(executionId, transfer) {
      const itemIndex = items.findIndex((item) => item.executionId === executionId);
      if (itemIndex === -1) throw createTranslationExecutionQueueItemNotFoundError(executionId);
      const item = items[itemIndex];
      assertOwnedProcessingItem(item, transfer);
      await resolvedDeadLetterQueueRepository.enqueue(createDeadLetterItem(item, transfer));
      return items.splice(itemIndex, 1)[0];
    },

    contains(executionId) {
      return items.some((item) => item.executionId === executionId);
    },

    claim(executionId, lease) {
      const itemIndex = items.findIndex((item) => item.executionId === executionId);
      if (itemIndex === -1) throwNotFound(executionId);
      if (items[itemIndex].status !== 'queued') {
        throw createDurableTranslationExecutionQueueItemNotClaimableError();
      }

      const claimedItem = createDurableTranslationExecutionQueueItem({
        ...items[itemIndex],
        status: 'processing',
        fenceToken: items[itemIndex].fenceToken + 1,
        ...lease
      });
      items[itemIndex] = claimedItem;
      return claimedItem;
    },

    retryClaim(executionId, retry) {
      const itemIndex = items.findIndex((item) => item.executionId === executionId);
      if (itemIndex === -1) throw createTranslationExecutionQueueItemNotFoundError(executionId);
      const item = items[itemIndex];
      if (item.status !== 'processing') throw createDurableTranslationExecutionQueueItemNotClaimableError();
      if (item.leaseId !== retry.leaseId || item.fenceToken !== retry.fenceToken) {
        throw createDurableTranslationExecutionQueueLeaseOwnershipError();
      }

      const requeuedItem = {
        ...item,
        status: 'queued',
        attempt: retry.attempt,
        availableAt: retry.availableAt,
        lastFailure: retry.lastFailure
      };
      delete requeuedItem.leaseId;
      delete requeuedItem.claimedAt;
      delete requeuedItem.leaseExpiresAt;
      items[itemIndex] = createDurableTranslationExecutionQueueItem(requeuedItem);
      return items[itemIndex];
    },

    renewClaim(executionId, claim, lease) {
      const itemIndex = items.findIndex((item) => item.executionId === executionId);
      if (itemIndex === -1) throw createTranslationExecutionQueueItemNotFoundError(executionId);
      const item = items[itemIndex];
      if (item.status !== 'processing') throw createDurableTranslationExecutionQueueItemNotClaimableError();
      if (item.leaseId !== claim.leaseId || item.leaseExpiresAt <= lease.now) {
        throw createDurableTranslationExecutionQueueLeaseOwnershipError();
      }

      const renewedItem = createDurableTranslationExecutionQueueItem({
        ...item,
        leaseExpiresAt: lease.leaseExpiresAt
      });
      items[itemIndex] = renewedItem;
      return renewedItem;
    },

    assertClaimActive(executionId, claim, now) {
      const item = items.find((candidate) => candidate.executionId === executionId);
      if (item === undefined) throw createTranslationExecutionQueueItemNotFoundError(executionId);
      if (item.status !== 'processing') throw createDurableTranslationExecutionQueueItemNotClaimableError();
      if (item.leaseId !== claim.leaseId || item.fenceToken !== claim.fenceToken || item.leaseExpiresAt <= now) {
        throw createDurableTranslationExecutionQueueLeaseOwnershipError();
      }
      return item;
    },

    requeueExpiredProcessing(executionId, now) {
      const itemIndex = items.findIndex((item) => item.executionId === executionId);
      const item = items[itemIndex];
      if (!isExpiredProcessingItem(item, now)) return null;

      const requeuedItem = createRequeuedItem(item);
      items[itemIndex] = requeuedItem;
      return requeuedItem;
    }
  });
}

function assertOwnedProcessingItem(item, claim) {
  if (item.status !== 'processing') throw createDurableTranslationExecutionQueueItemNotClaimableError();
  if (item.leaseId !== claim.leaseId || item.fenceToken !== claim.fenceToken) throw createDurableTranslationExecutionQueueLeaseOwnershipError();
}

function createDeadLetterItem(item, transfer) {
  return {
    executionId: item.executionId, requestId: item.requestId, attempt: item.attempt + 1,
    availableAt: item.availableAt, lastFailure: item.lastFailure,
    failedAt: transfer.failedAt, failure: transfer.failure,
    ...(transfer.providerKey === undefined ? {} : { providerKey: transfer.providerKey }),
    ...(transfer.providerMetadata === undefined ? {} : { providerMetadata: transfer.providerMetadata }),
    ...(transfer.executionMetadata === undefined ? {} : { executionMetadata: transfer.executionMetadata })
  };
}

function isExpiredProcessingItem(item, now) {
  return item !== undefined
    && item.status === 'processing'
    && item.leaseId !== undefined
    && item.leaseExpiresAt !== undefined
    && item.leaseExpiresAt <= now;
}

function createRequeuedItem(item) {
  const requeuedItem = { ...item, status: 'queued' };
  delete requeuedItem.leaseId;
  delete requeuedItem.claimedAt;
  delete requeuedItem.leaseExpiresAt;
  return createDurableTranslationExecutionQueueItem(requeuedItem);
}

function createUpdatedItem(item, status) {
  const nextItem = { ...item, status };
  if (status === 'queued' || status === 'completed' || status === 'failed') {
    delete nextItem.leaseId;
    delete nextItem.claimedAt;
    delete nextItem.leaseExpiresAt;
  }
  return createDurableTranslationExecutionQueueItem(nextItem);
}

function throwNotFound(executionId) { throw new Error(`Durable translation execution queue item ${executionId} was not found`); }

function cloneQueueItemOrNull(item) {
  if (item === null || item === undefined) {
    return null;
  }

  return createDurableTranslationExecutionQueueItem(item);
}
