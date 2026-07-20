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

export function createFakeDurableTranslationExecutionQueueRepository() {
  const items = [];

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
      if (item.leaseId !== claim.leaseId) throw createDurableTranslationExecutionQueueLeaseOwnershipError();
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
        ...lease
      });
      items[itemIndex] = claimedItem;
      return claimedItem;
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
