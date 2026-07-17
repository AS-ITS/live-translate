import {
  assertTranslationExecutionQueue,
  createTranslationExecutionQueue
} from '../application/translation/translationExecutionQueue.js';
import { assertDurableTranslationExecutionQueueRepository } from '../application/translation/durableTranslationExecutionQueueRepository.js';

export function createDualWriteTranslationExecutionQueue({ primaryQueue, durableRepository, clock } = {}) {
  assertTranslationExecutionQueue(primaryQueue);
  assertDurableTranslationExecutionQueueRepository(durableRepository);
  assertClock(clock);

  return createTranslationExecutionQueue({
    async enqueue(item) {
      await durableRepository.enqueue({
        executionId: item.executionId,
        requestId: item.requestId,
        enqueuedAt: clock.now()
      });

      return primaryQueue.enqueue({
        executionId: item.executionId,
        requestId: item.requestId
      });
    },

    dequeue() {
      return primaryQueue.dequeue();
    },

    size() {
      return primaryQueue.size();
    }
  });
}

function assertClock(clock) {
  if (!clock || typeof clock !== 'object') {
    throw new TypeError('clock is required.');
  }

  if (typeof clock.now !== 'function') {
    throw new TypeError('clock.now must be a function.');
  }
}
