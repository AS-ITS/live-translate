import { createTranslationExecutionQueue } from '../application/translation/translationExecutionQueue.js';

export function createInMemoryTranslationExecutionQueue() {
  const jobs = [];

  return createTranslationExecutionQueue({
    enqueue(job) {
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
