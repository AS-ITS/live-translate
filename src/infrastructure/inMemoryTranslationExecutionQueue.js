import { createTranslationExecutionQueue } from '../application/translation/translationExecutionQueue.js';
import {
  compareDurableTranslationExecutionQueueItemIdentity,
  createTranslationExecutionQueueItemConflictError,
  DURABLE_TRANSLATION_EXECUTION_QUEUE_ITEM_IDENTITY
} from '../application/translation/durableTranslationExecutionQueueRepository.js';

export function createInMemoryTranslationExecutionQueue() {
  const jobs = [];

  return createTranslationExecutionQueue({
    enqueue(job) {
      const existingJob = jobs.find((candidate) => candidate.executionId === job.executionId);
      if (existingJob !== undefined) {
        if (compareDurableTranslationExecutionQueueItemIdentity(existingJob, job)
          === DURABLE_TRANSLATION_EXECUTION_QUEUE_ITEM_IDENTITY.CONFLICT) {
          throw createTranslationExecutionQueueItemConflictError();
        }

        return undefined;
      }

      jobs.push(job);
      return undefined;
    },

    dequeue() {
      return jobs.shift() ?? null;
    },

    size() {
      return jobs.length;
    }
  });
}
