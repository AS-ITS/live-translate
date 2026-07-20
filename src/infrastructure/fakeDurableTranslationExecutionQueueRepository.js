import {
  createDurableTranslationExecutionQueueItem,
  createDurableTranslationExecutionQueueRepository
} from '../application/translation/durableTranslationExecutionQueueRepository.js';

export function createFakeDurableTranslationExecutionQueueRepository() {
  const items = [];

  return createDurableTranslationExecutionQueueRepository({
    enqueue(item) {
      if (items.some((existingItem) => existingItem.executionId === item.executionId)) {
        return undefined;
      }

      items.push(createDurableTranslationExecutionQueueItem(item));
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

      items[itemIndex] = createDurableTranslationExecutionQueueItem({
        ...items[itemIndex],
        status
      });
      return undefined;
    },

    acknowledge(executionId) {
      const itemIndex = items.findIndex((item) => item.executionId === executionId);

      if (itemIndex === -1) {
        throw new Error(`Durable translation execution queue item ${executionId} was not found`);
      }

      items.splice(itemIndex, 1);
      return undefined;
    },

    contains(executionId) {
      return items.some((item) => item.executionId === executionId);
    },

    claim(executionId, leasedUntil) {
      updateLease(items, executionId, leasedUntil);
    },

    releaseExpired(now) {
      return releaseExpiredLeases(items, now);
    },

    isLeaseExpired(executionId, now) {
      const item = findItem(items, executionId);
      if (item === undefined) throwNotFound(executionId);
      return item.leasedUntil !== null && item.leasedUntil <= now;
    },

    renewLease(executionId, leasedUntil) {
      updateLease(items, executionId, leasedUntil);
    }
  });
}

function updateLease(items, executionId, leasedUntil) {
  const itemIndex = items.findIndex((item) => item.executionId === executionId);
  if (itemIndex === -1) throwNotFound(executionId);
  items[itemIndex] = createDurableTranslationExecutionQueueItem({ ...items[itemIndex], leasedUntil });
}

function releaseExpiredLeases(items, now) {
  let released = 0;
  for (let index = 0; index < items.length; index += 1) {
    if (items[index].leasedUntil !== null && items[index].leasedUntil <= now) {
      items[index] = createDurableTranslationExecutionQueueItem({ ...items[index], leasedUntil: null });
      released += 1;
    }
  }
  return released;
}

function findItem(items, executionId) { return items.find((item) => item.executionId === executionId); }
function throwNotFound(executionId) { throw new Error(`Durable translation execution queue item ${executionId} was not found`); }

function cloneQueueItemOrNull(item) {
  if (item === null || item === undefined) {
    return null;
  }

  return createDurableTranslationExecutionQueueItem(item);
}
