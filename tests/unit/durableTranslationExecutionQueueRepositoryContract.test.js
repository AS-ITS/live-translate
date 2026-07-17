import assert from 'node:assert/strict';
import test from 'node:test';
import { INVALID_TRANSLATION_EXECUTION_QUEUE_ITEM_CODE } from '../../src/application/translation/translationExecutionQueue.js';
import { createFakeDurableTranslationExecutionQueueRepository } from '../../src/infrastructure/fakeDurableTranslationExecutionQueueRepository.js';

export function runDurableQueueRepositoryContract({ createRepository }) {
  test('enqueue stores an item', async () => {
    const repository = createRepository();

    await repository.enqueue(createItem());

    assert.equal(await repository.size(), 1);
  });

  test('dequeue returns items in FIFO order', async () => {
    const repository = createRepository();
    const first = createItem({ executionId: 'execution-1', requestId: 'request-1' });
    const second = createItem({ executionId: 'execution-2', requestId: 'request-2' });
    const third = createItem({ executionId: 'execution-3', requestId: 'request-3' });

    await repository.enqueue(first);
    await repository.enqueue(second);
    await repository.enqueue(third);

    assert.deepEqual(await repository.dequeue(), first);
    assert.deepEqual(await repository.dequeue(), second);
    assert.deepEqual(await repository.dequeue(), third);
  });

  test('peek returns next item without removing it', async () => {
    const repository = createRepository();
    const item = createItem();

    await repository.enqueue(item);

    assert.deepEqual(await repository.peek(), item);
    assert.equal(await repository.size(), 1);
    assert.deepEqual(await repository.dequeue(), item);
  });

  test('dequeue removes the returned item', async () => {
    const repository = createRepository();
    const item = createItem();

    await repository.enqueue(item);

    assert.deepEqual(await repository.dequeue(), item);
    assert.equal(await repository.size(), 0);
    assert.equal(await repository.dequeue(), null);
  });

  test('size reflects queue length', async () => {
    const repository = createRepository();

    assert.equal(await repository.size(), 0);

    await repository.enqueue(createItem({ executionId: 'execution-1', requestId: 'request-1' }));
    assert.equal(await repository.size(), 1);

    await repository.enqueue(createItem({ executionId: 'execution-2', requestId: 'request-2' }));
    assert.equal(await repository.size(), 2);

    await repository.dequeue();
    assert.equal(await repository.size(), 1);
  });

  test('clear removes all items', async () => {
    const repository = createRepository();

    await repository.enqueue(createItem({ executionId: 'execution-1', requestId: 'request-1' }));
    await repository.enqueue(createItem({ executionId: 'execution-2', requestId: 'request-2' }));

    await repository.clear();

    assert.equal(await repository.size(), 0);
    assert.equal(await repository.peek(), null);
    assert.equal(await repository.dequeue(), null);
  });

  test('dequeue empty returns null', async () => {
    const repository = createRepository();

    assert.equal(await repository.dequeue(), null);
  });

  test('peek empty returns null', async () => {
    const repository = createRepository();

    assert.equal(await repository.peek(), null);
  });

  test('invalid enqueue rejects with stable error code', async () => {
    const repository = createRepository();

    for (const invalidItem of [
      null,
      undefined,
      [],
      'execution-1',
      { requestId: 'request-1', enqueuedAt: enqueuedAt() },
      { executionId: 'execution-1', enqueuedAt: enqueuedAt() },
      { executionId: 'execution-1', requestId: 'request-1' },
      { executionId: '', requestId: 'request-1', enqueuedAt: enqueuedAt() },
      { executionId: 'execution-1', requestId: '   ', enqueuedAt: enqueuedAt() },
      { executionId: 'execution-1', requestId: 'request-1', enqueuedAt: '2026-07-17T08:00:00Z' },
      { executionId: 'execution-1', requestId: 'request-1', enqueuedAt: '2026-07-17T08:00:00.000+00:00' },
      { executionId: 'execution-1', requestId: 'request-1', enqueuedAt: 'not-a-date' }
    ]) {
      await assert.rejects(
        () => repository.enqueue(invalidItem),
        (error) => error instanceof TypeError && error.code === INVALID_TRANSLATION_EXECUTION_QUEUE_ITEM_CODE
      );
    }
  });

  test('invalid enqueue does not change repository state', async () => {
    const repository = createRepository();
    const item = createItem();

    await repository.enqueue(item);

    await assert.rejects(
      () => repository.enqueue({ executionId: '', requestId: 'request-2', enqueuedAt: enqueuedAt() }),
      (error) => error.code === INVALID_TRANSLATION_EXECUTION_QUEUE_ITEM_CODE
    );

    assert.equal(await repository.size(), 1);
    assert.deepEqual(await repository.dequeue(), item);
    assert.equal(await repository.size(), 0);
  });

  test('enqueue does not modify the input item', async () => {
    const repository = createRepository();
    const item = createItem({
      metadata: {
        source: 'contract-test'
      }
    });
    const before = structuredClone(item);

    await repository.enqueue(item);

    assert.deepEqual(item, before);
  });

  test('dequeue returns a new immutable object', async () => {
    const repository = createRepository();
    const item = createItem();

    await repository.enqueue(item);
    const dequeued = await repository.dequeue();

    assert.notStrictEqual(dequeued, item);
    assert.deepEqual(dequeued, item);
    assert.equal(Object.isFrozen(dequeued), true);
  });
}

runDurableQueueRepositoryContract({
  createRepository: createFakeDurableTranslationExecutionQueueRepository
});

function createItem(overrides = {}) {
  return {
    executionId: 'execution-1',
    requestId: 'request-1',
    enqueuedAt: enqueuedAt(),
    ...overrides
  };
}

function enqueuedAt() {
  return '2026-07-17T08:00:00.000Z';
}
