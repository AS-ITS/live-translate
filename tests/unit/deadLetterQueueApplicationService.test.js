import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeadLetterQueueApplicationService } from '../../src/application/translation/deadLetterQueueApplicationService.js';

const item = (executionId) => ({
  executionId,
  requestId: 'request-1',
  attempt: 3,
  availableAt: null,
  lastFailure: { code: 'provider_unavailable' },
  failedAt: '2026-08-10T00:00:00.000Z',
  failure: { name: 'Error', message: 'provider failed' },
  providerKey: 'gemini',
  providerMetadata: { model: 'test-model' },
  executionMetadata: { source: 'worker' }
});

function repository(items) {
  return {
    async enqueue() {},
    async list() { return items; },
    async size() { return items.length; },
    async clear() {}
  };
}

test('lists the complete DLQ in repository order with size', async () => {
  const items = [item('execution-1'), item('execution-2')];
  const service = createDeadLetterQueueApplicationService({
    deadLetterQueueRepository: repository(items),
    manualRetryFailedTranslationExecutionService: { async retryFailedExecution() {} }
  });

  assert.deepEqual(await service.listItems(), { items, size: 2 });
});

test('replay verifies the DLQ item, delegates retry, and retains the item', async () => {
  const items = [item('execution-1')];
  const replayed = { id: 'execution-2', status: 'queued', translationRequestId: 'request-1' };
  const calls = [];
  const service = createDeadLetterQueueApplicationService({
    deadLetterQueueRepository: repository(items),
    manualRetryFailedTranslationExecutionService: {
      async retryFailedExecution(input) {
        calls.push(input);
        return replayed;
      }
    }
  });

  assert.deepEqual(await service.replayItem({ executionId: 'execution-1' }), {
    sourceExecutionId: 'execution-1',
    execution: replayed
  });
  assert.deepEqual(calls, [{ executionId: 'execution-1' }]);
  assert.deepEqual(await service.listItems(), { items, size: 1 });
});

test('missing DLQ item fails before retry enqueue', async () => {
  let calls = 0;
  const service = createDeadLetterQueueApplicationService({
    deadLetterQueueRepository: repository([]),
    manualRetryFailedTranslationExecutionService: {
      async retryFailedExecution() { calls += 1; }
    }
  });

  await assert.rejects(
    service.replayItem({ executionId: 'missing' }),
    (error) => error.code === 'dead_letter_item_not_found'
  );
  assert.equal(calls, 0);
});
