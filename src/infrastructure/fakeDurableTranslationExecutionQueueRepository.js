import {
  createDurableTranslationExecutionQueueItem,
  createDurableTranslationExecutionQueueRepository
} from '../application/translation/durableTranslationExecutionQueueRepository.js';

export function createFakeDurableTranslationExecutionQueueRepository() {
  const items = [];

  return createDurableTranslationExecutionQueueRepository({
    enqueue(item) {
      items.push(createDurableTranslationExecutionQueueItem(item));
      return undefined;
    },

    dequeue() {
      return cloneQueueItemOrNull(items.shift());
    },

    peek() {
      return cloneQueueItemOrNull(items[0]);
    },

    size() {
      return items.length;
    },

    clear() {
      items.length = 0;
      return undefined;
    }
  });
}

function cloneQueueItemOrNull(item) {
  if (item === null || item === undefined) {
    return null;
  }

  return createDurableTranslationExecutionQueueItem(item);
}
