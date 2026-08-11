import { assertDeadLetterQueueRepository } from './deadLetterQueueRepository.js';

export function createDeadLetterQueueApplicationService({
  deadLetterQueueRepository,
  manualRetryFailedTranslationExecutionService
} = {}) {
  assertDeadLetterQueueRepository(deadLetterQueueRepository);
  if (!manualRetryFailedTranslationExecutionService || typeof manualRetryFailedTranslationExecutionService.retryFailedExecution !== 'function') {
    throw new TypeError('manualRetryFailedTranslationExecutionService.retryFailedExecution must be a function.');
  }

  return Object.freeze({
    async listItems() {
      const [items, size] = await Promise.all([
        deadLetterQueueRepository.list(),
        deadLetterQueueRepository.size()
      ]);
      return { items, size };
    },

    async replayItem({ executionId } = {}) {
      assertExecutionId(executionId);
      const item = (await deadLetterQueueRepository.list()).find((candidate) => candidate.executionId === executionId);
      if (!item) throw deadLetterItemNotFoundError(executionId);

      const execution = await manualRetryFailedTranslationExecutionService.retryFailedExecution({ executionId });
      return { sourceExecutionId: executionId, execution };
    }
  });
}

function assertExecutionId(executionId) {
  if (typeof executionId !== 'string' || executionId.trim().length === 0) {
    const error = new TypeError('executionId must be a non-empty string.');
    error.code = 'invalid_request';
    throw error;
  }
}

function deadLetterItemNotFoundError(executionId) {
  const error = new Error(`Dead-letter queue item ${executionId} was not found`);
  error.code = 'dead_letter_item_not_found';
  return error;
}
