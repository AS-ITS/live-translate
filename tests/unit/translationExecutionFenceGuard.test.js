import assert from 'node:assert/strict';
import test from 'node:test';
import { createTranslationExecutionFenceGuard } from '../../src/application/translation/translationExecutionFenceGuard.js';
import { createFakeDurableTranslationExecutionQueueRepository } from '../../src/infrastructure/fakeDurableTranslationExecutionQueueRepository.js';

test('fence guard forwards the injected time and claim without mutating durable state', async () => {
  const repository = createFakeDurableTranslationExecutionQueueRepository();
  await repository.enqueue({ executionId: 'execution-1', requestId: 'request-1', enqueuedAt: '2026-07-21T00:00:00.000Z' });
  await repository.claim('execution-1', { leaseId: 'lease-1', leaseExpiresAt: '2026-07-21T00:05:00.000Z' });
  const guard = createTranslationExecutionFenceGuard({
    durableTranslationExecutionQueueRepository: repository,
    clock: () => '2026-07-21T00:01:00.000Z'
  });

  const item = await guard.assertWritable({ executionId: 'execution-1', claim: { leaseId: 'lease-1', fenceToken: 1 } });

  assert.equal(item.fenceToken, 1);
  assert.deepEqual(await repository.peek(), item);
});

test('fence guard preserves repository error identity and rejects invalid clock results', async () => {
  const error = new Error('ownership lost');
  const guard = createTranslationExecutionFenceGuard({
    durableTranslationExecutionQueueRepository: { assertClaimActive() { throw error; }, enqueue() {}, dequeue() {}, peek() {}, list() {}, listAvailable() {}, nextAvailableAt() {}, size() {}, clear() {}, updateStatus() {}, acknowledge() {}, acknowledgeClaim() {}, contains() {}, claim() {}, retryClaim() {}, renewClaim() {}, requeueExpiredProcessing() {} },
    clock: () => '2026-07-21T00:01:00.000Z'
  });
  await assert.rejects(() => guard.assertWritable({ executionId: 'execution-1', claim: { leaseId: 'lease-1', fenceToken: 1 } }), (actual) => actual === error);

  const badClockGuard = createTranslationExecutionFenceGuard({
    durableTranslationExecutionQueueRepository: { assertClaimActive() {}, enqueue() {}, dequeue() {}, peek() {}, list() {}, listAvailable() {}, nextAvailableAt() {}, size() {}, clear() {}, updateStatus() {}, acknowledge() {}, acknowledgeClaim() {}, contains() {}, claim() {}, retryClaim() {}, renewClaim() {}, requeueExpiredProcessing() {} },
    clock: () => 'not-a-date'
  });
  await assert.rejects(() => badClockGuard.assertWritable({ executionId: 'execution-1', claim: { leaseId: 'lease-1', fenceToken: 1 } }), /clock must return/);
});
