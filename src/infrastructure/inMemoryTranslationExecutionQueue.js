import { assertTranslationExecutionQueueJob } from '../application/translation/translationExecutionQueue.js';

export function createInMemoryTranslationExecutionQueue() {
  const jobs = [];

  return Object.freeze({
    enqueue(job) {
      assertTranslationExecutionQueueJob(job);
      jobs.push(job);
      return undefined;
    },

    dequeue() {
      return jobs.shift();
    },

    size() {
      return jobs.length;
    }
  });
}
