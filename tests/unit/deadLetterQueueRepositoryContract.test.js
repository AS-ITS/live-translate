import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeadLetterQueueItem } from '../../src/application/translation/deadLetterQueueRepository.js';
import { createFakeDeadLetterQueueRepository } from '../../src/infrastructure/fakeDeadLetterQueueRepository.js';

export function runDeadLetterQueueRepositoryContract({ createRepository }) {
  test('dead-letter item validates its required retry failure contract', () => {
    assert.deepEqual(createDeadLetterQueueItem(createItem()), createItem());
    for (const item of [
      createItem({ attempt: -1 }),
      createItem({ failedAt: 'not-a-date' }),
      createItem({ failure: null })
    ]) {
      assert.throws(
        () => createDeadLetterQueueItem(item),
        (error) => error instanceof TypeError && error.code === 'invalid_dead_letter_queue_item'
      );
    }
  });

  test('enqueue and list preserve FIFO order and metadata', async () => {
    const repository = createRepository();
    const first = createItem({ executionId: 'execution-1', requestId: 'request-1' });
    const second = createItem({ executionId: 'execution-2', requestId: 'request-2', attempt: 2 });

    await repository.enqueue(first);
    await repository.enqueue(second);

    assert.deepEqual(await repository.list(), [first, second]);
    assert.equal(Object.isFrozen(await repository.list()), true);
    assert.equal(await repository.size(), 2);
  });

  test('enqueue is idempotent by executionId', async () => {
    const repository = createRepository();
    const item = createItem();
    await repository.enqueue(item);
    await repository.enqueue({ ...item, failure: { code: 'different' } });
    assert.deepEqual(await repository.list(), [item]);
  });

  test('clear removes all items', async () => {
    const repository = createRepository();
    await repository.enqueue(createItem());
    await repository.clear();
    assert.equal(await repository.size(), 0);
    assert.deepEqual(await repository.list(), []);
  });
}

runDeadLetterQueueRepositoryContract({ createRepository: createFakeDeadLetterQueueRepository });

export function createItem(overrides = {}) {
  return {
    executionId: 'execution-1',
    requestId: 'request-1',
    attempt: 1,
    availableAt: null,
    lastFailure: null,
    failedAt: '2026-07-18T08:00:00.000Z',
    failure: { code: 'provider_unavailable', message: 'Provider unavailable' },
    providerKey: 'fake',
    providerMetadata: { provider: 'fake' },
    executionMetadata: { targetLanguageCode: 'zh-Hant' },
    ...overrides
  };
}
