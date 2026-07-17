import { assertTranslationExecutionQueue } from './translationExecutionQueue.js';
import { assertDurableTranslationExecutionQueueRepository } from './durableTranslationExecutionQueueRepository.js';

export function createStartupTranslationExecutionQueueRecovery({ durableRepository, activeQueue } = {}) {
  assertDurableTranslationExecutionQueueRepository(durableRepository);
  assertTranslationExecutionQueue(activeQueue);

  return Object.freeze({
    async recover() {
      while (true) {
        const item = await durableRepository.peek();

        if (item === null) {
          return;
        }

        await activeQueue.enqueue({
          executionId: item.executionId,
          requestId: item.requestId
        });
        await durableRepository.dequeue();
      }
    }
  });
}
