import { createTranslationExecutionQueue } from '../application/translation/translationExecutionQueue.js';

export function createInMemoryTranslationExecutionQueue() {
  const jobs = [];

  return createTranslationExecutionQueue({
    enqueue(job) {
      jobs.push(job);
      return undefined;
    },

    dequeue() {
      return jobs.shift();
    },

    isEmpty() {
      return jobs.length === 0;
    },

    size() {
      return jobs.length;
    }
  });
}
