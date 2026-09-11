import {
  assertTranslationExecutionQueue,
  createTranslationExecutionQueue
} from '../application/translation/translationExecutionQueue.js';
import { assertDurableTranslationExecutionQueueRepository } from '../application/translation/durableTranslationExecutionQueueRepository.js';
import { DURABLE_TRANSLATION_EXECUTION_QUEUE_ITEM_STATUSES } from '../application/translation/durableTranslationExecutionQueueRepository.js';
import { currentRequestUserId, isWorkerRequestContext, setRequestUser } from '../../server/requestIdentity.js';

export function createDualWriteTranslationExecutionQueue({ primaryQueue, durableRepository, clock } = {}) {
  assertTranslationExecutionQueue(primaryQueue);
  assertDurableTranslationExecutionQueueRepository(durableRepository);
  assertClock(clock);

  return createTranslationExecutionQueue({
    async enqueue(item) {
      const ownerUserId = item.ownerUserId || currentRequestUserId() || undefined;
      if (await durableRepository.contains(item.executionId)) {
        return undefined;
      }

      await durableRepository.enqueue({
        executionId: item.executionId,
        requestId: item.requestId,
        ...(ownerUserId ? { ownerUserId } : {}),
        enqueuedAt: clock.now(),
        status: DURABLE_TRANSLATION_EXECUTION_QUEUE_ITEM_STATUSES.QUEUED
      });

      if (isWorkerRequestContext() && ownerUserId) setRequestUser({ id: ownerUserId, kind: 'worker' });

      return primaryQueue.enqueue({
        executionId: item.executionId,
        requestId: item.requestId,
        ...(ownerUserId ? { ownerUserId } : {})
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
