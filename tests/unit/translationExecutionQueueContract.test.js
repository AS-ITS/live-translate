import assert from 'node:assert/strict';
import test from 'node:test';
import { INVALID_TRANSLATION_EXECUTION_QUEUE_ITEM_CODE } from '../../src/application/translation/translationExecutionQueue.js';
import { createInMemoryTranslationExecutionQueue } from '../../src/infrastructure/inMemoryTranslationExecutionQueue.js';

export function runTranslationExecutionQueueContract({ createQueue }) {
  test('new queue size is 0', () => {
    const queue = createQueue();

    assert.equal(queue.size(), 0);
  });

  test('enqueue increases size', () => {
    const queue = createQueue();

    queue.enqueue(createItem());

    assert.equal(queue.size(), 1);
  });

  test('dequeue returns the enqueued item', () => {
    const queue = createQueue();
    const item = createItem();

    queue.enqueue(item);

    assert.strictEqual(queue.dequeue(), item);
  });

  test('dequeue decreases size', () => {
    const queue = createQueue();
    const item = createItem();

    queue.enqueue(item);
    queue.dequeue();

    assert.equal(queue.size(), 0);
  });

  test('multiple items follow FIFO order', () => {
    const queue = createQueue();
    const first = createItem({ executionId: 'execution-1', requestId: 'request-1' });
    const second = createItem({ executionId: 'execution-2', requestId: 'request-2' });
    const third = createItem({ executionId: 'execution-3', requestId: 'request-3' });

    queue.enqueue(first);
    queue.enqueue(second);
    queue.enqueue(third);

    assert.strictEqual(queue.dequeue(), first);
    assert.strictEqual(queue.dequeue(), second);
    assert.strictEqual(queue.dequeue(), third);
  });

  test('empty queue dequeue returns null', () => {
    const queue = createQueue();

    assert.equal(queue.dequeue(), null);
  });

  test('dequeue does not return the same item twice', () => {
    const queue = createQueue();
    const item = createItem();

    queue.enqueue(item);

    assert.strictEqual(queue.dequeue(), item);
    assert.equal(queue.dequeue(), null);
  });

  test('invalid items are rejected with a stable error code', () => {
    const queue = createQueue();

    for (const invalidItem of [
      null,
      undefined,
      [],
      'execution-1',
      { requestId: 'request-1' },
      { executionId: 'execution-1' },
      { executionId: '', requestId: 'request-1' },
      { executionId: 'execution-1', requestId: '   ' }
    ]) {
      assert.throws(
        () => queue.enqueue(invalidItem),
        (error) => error instanceof TypeError && error.code === INVALID_TRANSLATION_EXECUTION_QUEUE_ITEM_CODE
      );
    }
  });

  test('invalid enqueue does not change existing queue state', () => {
    const queue = createQueue();
    const item = createItem();

    queue.enqueue(item);

    assert.throws(
      () => queue.enqueue({ executionId: '', requestId: 'request-2' }),
      (error) => error.code === INVALID_TRANSLATION_EXECUTION_QUEUE_ITEM_CODE
    );

    assert.equal(queue.size(), 1);
    assert.strictEqual(queue.dequeue(), item);
    assert.equal(queue.size(), 0);
  });

  test('enqueue does not modify the input item', () => {
    const queue = createQueue();
    const item = createItem({
      metadata: {
        source: 'contract-test'
      }
    });
    const before = structuredClone(item);

    queue.enqueue(item);

    assert.deepEqual(item, before);
  });
}

runTranslationExecutionQueueContract({
  createQueue: createInMemoryTranslationExecutionQueue
});

function createItem(overrides = {}) {
  return {
    executionId: 'execution-1',
    requestId: 'request-1',
    ...overrides
  };
}
