import {
  assertDurableTranslationExecutionQueueActiveClaim,
  assertDurableTranslationExecutionQueueRepository
} from './durableTranslationExecutionQueueRepository.js';

export function createTranslationExecutionFenceGuard({
  durableTranslationExecutionQueueRepository,
  clock
} = {}) {
  assertDurableTranslationExecutionQueueRepository(durableTranslationExecutionQueueRepository);
  if (typeof clock !== 'function') throw new TypeError('clock must be a function.');

  return Object.freeze({
    async assertWritable({ executionId, claim } = {}) {
      if (typeof executionId !== 'string' || executionId.trim().length === 0) {
        throw new TypeError('executionId must be a non-empty string.');
      }
      assertDurableTranslationExecutionQueueActiveClaim(claim);
      const now = clock();
      if (!isIsoUtcString(now)) throw new TypeError('clock must return an ISO-8601 UTC string.');
      return durableTranslationExecutionQueueRepository.assertClaimActive(executionId, claim, now);
    }
  });
}

function isIsoUtcString(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}
