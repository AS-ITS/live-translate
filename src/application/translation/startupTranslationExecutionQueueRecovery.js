import { assertTranslationExecutionQueue } from './translationExecutionQueue.js';
import {
  assertDurableTranslationExecutionQueueRepository,
  compareDurableTranslationExecutionQueueItemIdentity,
  createTranslationExecutionQueueItemConflictError,
  DURABLE_TRANSLATION_EXECUTION_QUEUE_ITEM_IDENTITY
} from './durableTranslationExecutionQueueRepository.js';

export function createStartupTranslationExecutionQueueRecovery({ durableRepository, activeQueue, clock = () => new Date().toISOString() } = {}) {
  assertDurableTranslationExecutionQueueRepository(durableRepository);
  assertTranslationExecutionQueue(activeQueue);
  if (typeof clock !== 'function') throw new TypeError('clock must be a function.');

  const replayedExecutionIds = new Set();

  return Object.freeze({
    async recover() {
      const items = await durableRepository.list();
      const now = clock();
      const eligibleItems = [];
      const itemsByExecutionId = new Map();

      for (const item of items) {
        const existingItem = itemsByExecutionId.get(item.executionId);
        if (existingItem !== undefined) {
          if (compareDurableTranslationExecutionQueueItemIdentity(existingItem, item)
            === DURABLE_TRANSLATION_EXECUTION_QUEUE_ITEM_IDENTITY.CONFLICT) {
            throw createTranslationExecutionQueueItemConflictError();
          }

          continue;
        }

        itemsByExecutionId.set(item.executionId, item);
        const noLease = item.leasedUntil === null || item.leasedUntil === undefined;
        const expired = !noLease && item.leasedUntil <= now;
        const status = item.status ?? 'queued';
        if ((status === 'queued' && (noLease || expired)) || (status === 'processing' && expired)) {
          eligibleItems.push(item);
        }
      }

      await durableRepository.releaseExpired(now);

      for (const item of eligibleItems) {
        if (replayedExecutionIds.has(item.executionId)) {
          continue;
        }

        await activeQueue.enqueue({
          executionId: item.executionId,
          requestId: item.requestId
        });
        replayedExecutionIds.add(item.executionId);
      }
    }
  });
}
