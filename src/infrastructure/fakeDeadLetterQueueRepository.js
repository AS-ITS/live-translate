import {
  createDeadLetterQueueItem,
  createDeadLetterQueueRepository
} from '../application/translation/deadLetterQueueRepository.js';

export function createFakeDeadLetterQueueRepository() {
  const items = [];

  return createDeadLetterQueueRepository({
    enqueue(item) {
      if (!items.some((candidate) => candidate.executionId === item.executionId)) items.push(createDeadLetterQueueItem(item));
    },
    list() {
      return items.map((item) => createDeadLetterQueueItem(item));
    },
    size() {
      return items.length;
    },
    clear() {
      items.length = 0;
    }
  });
}
