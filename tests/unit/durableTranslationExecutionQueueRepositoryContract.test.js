import assert from 'node:assert/strict';
import test from 'node:test';
import { INVALID_TRANSLATION_EXECUTION_QUEUE_ITEM_CODE } from '../../src/application/translation/translationExecutionQueue.js';
import {
  compareDurableTranslationExecutionQueueItemIdentity,
  createDurableTranslationExecutionQueueItem,
  DURABLE_TRANSLATION_EXECUTION_QUEUE_ITEM_IDENTITY,
  DURABLE_TRANSLATION_EXECUTION_QUEUE_ITEM_STATUSES,
  TRANSLATION_EXECUTION_QUEUE_ITEM_CONFLICT_CODE,
  TRANSLATION_EXECUTION_QUEUE_ITEM_NOT_FOUND_CODE
} from '../../src/application/translation/durableTranslationExecutionQueueRepository.js';
import { createFakeDurableTranslationExecutionQueueRepository } from '../../src/infrastructure/fakeDurableTranslationExecutionQueueRepository.js';

export function runDurableQueueRepositoryContract({ createRepository }) {
  test('durable queue item identity compares same conflict and distinct items', () => {
    const item = createItem();

    assert.equal(
      compareDurableTranslationExecutionQueueItemIdentity(item, createItem()),
      DURABLE_TRANSLATION_EXECUTION_QUEUE_ITEM_IDENTITY.SAME
    );
    assert.equal(
      compareDurableTranslationExecutionQueueItemIdentity(item, createItem({ requestId: 'other-request' })),
      DURABLE_TRANSLATION_EXECUTION_QUEUE_ITEM_IDENTITY.CONFLICT
    );
    assert.equal(
      compareDurableTranslationExecutionQueueItemIdentity(item, createItem({ executionId: 'other-execution' })),
      DURABLE_TRANSLATION_EXECUTION_QUEUE_ITEM_IDENTITY.DISTINCT
    );
  });

  test('durable queue item statuses expose the supported immutable lifecycle set', () => {
    assert.deepEqual(DURABLE_TRANSLATION_EXECUTION_QUEUE_ITEM_STATUSES, {
      QUEUED: 'queued',
      PROCESSING: 'processing',
      COMPLETED: 'completed',
      FAILED: 'failed'
    });
    assert.equal(Object.isFrozen(DURABLE_TRANSLATION_EXECUTION_QUEUE_ITEM_STATUSES), true);
    assert.throws(() => {
      DURABLE_TRANSLATION_EXECUTION_QUEUE_ITEM_STATUSES.ACKNOWLEDGED = 'acknowledged';
    }, TypeError);
  });

  test('durable queue item defaults missing status to queued', () => {
    assert.deepEqual(createDurableTranslationExecutionQueueItem(createItemWithoutStatus()), createItem());
  });

  test('durable queue item preserves explicit legal status', () => {
    const item = createDurableTranslationExecutionQueueItem(createItemWithoutStatus({ status: 'processing' }));

    assert.equal(item.status, 'processing');
  });

  test('durable queue item rejects invalid status', () => {
    for (const status of ['', '   ', 'unknown', null, undefined, 1, true, {}, []]) {
      assert.throws(
        () => createDurableTranslationExecutionQueueItem(createItemWithoutStatus({ status })),
        (error) => error instanceof TypeError && error.code === INVALID_TRANSLATION_EXECUTION_QUEUE_ITEM_CODE
      );
    }
  });

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

  test('list returns items in FIFO order without removing them', async () => {
    const repository = createRepository();
    const first = createItem({ executionId: 'execution-1', requestId: 'request-1' });
    const second = createItem({ executionId: 'execution-2', requestId: 'request-2' });

    await repository.enqueue(first);
    await repository.enqueue(second);

    const items = await repository.list();

    assert.deepEqual(items, [first, second]);
    assert.equal(Object.isFrozen(items), true);
    assert.equal(Object.isFrozen(items[0]), true);
    assert.equal(await repository.size(), 2);
    assert.deepEqual(await repository.dequeue(), first);
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

  test('list empty returns an immutable empty array', async () => {
    const repository = createRepository();
    const items = await repository.list();

    assert.deepEqual(items, []);
    assert.equal(Object.isFrozen(items), true);
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
      { executionId: 1, requestId: 'request-1', enqueuedAt: enqueuedAt() },
      { executionId: 'execution-1', requestId: false, enqueuedAt: enqueuedAt() },
      { executionId: 'execution-1', requestId: 'request-1', enqueuedAt: '2026-07-17T08:00:00Z' },
      { executionId: 'execution-1', requestId: 'request-1', enqueuedAt: '2026-07-17T08:00:00.000+00:00' },
      { executionId: 'execution-1', requestId: 'request-1', enqueuedAt: 'not-a-date' },
      { executionId: 'execution-1', requestId: 'request-1', enqueuedAt: enqueuedAt(), status: '' },
      { executionId: 'execution-1', requestId: 'request-1', enqueuedAt: enqueuedAt(), status: 'unknown' },
      { executionId: 'execution-1', requestId: 'request-1', enqueuedAt: enqueuedAt(), status: 1 }
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

  test('enqueued item without status is persisted with queued status', async () => {
    const repository = createRepository();

    await repository.enqueue(createItemWithoutStatus());

    assert.deepEqual(await repository.peek(), createItem());
  });

  test('status can be updated through processing completed and failed states', async () => {
    const repository = createRepository();

    await repository.enqueue(createItem());
    await repository.updateStatus('execution-1', 'processing');
    assert.equal((await repository.peek()).status, 'processing');

    await repository.updateStatus('execution-1', 'completed');
    assert.equal((await repository.peek()).status, 'completed');

    await repository.updateStatus('execution-1', 'processing');
    await repository.updateStatus('execution-1', 'failed');
    assert.equal((await repository.peek()).status, 'failed');
  });

  test('status update preserves identity payload item count and queue ordering', async () => {
    const repository = createRepository();
    const first = createItem({ executionId: 'execution-1', requestId: 'request-1' });
    const second = createItem({ executionId: 'execution-2', requestId: 'request-2' });
    const third = createItem({ executionId: 'execution-3', requestId: 'request-3' });

    await repository.enqueue(first);
    await repository.enqueue(second);
    await repository.enqueue(third);
    await repository.updateStatus('execution-2', 'processing');

    assert.equal(await repository.size(), 3);
    assert.deepEqual(await repository.dequeue(), first);
    assert.deepEqual(await repository.dequeue(), { ...second, status: 'processing' });
    assert.deepEqual(await repository.dequeue(), third);
  });

  test('invalid status update fails without changing repository state', async () => {
    const repository = createRepository();
    const item = createItem();

    await repository.enqueue(item);

    await assert.rejects(
      () => repository.updateStatus('execution-1', 'unknown'),
      (error) => error instanceof TypeError && error.code === INVALID_TRANSLATION_EXECUTION_QUEUE_ITEM_CODE
    );

    assert.deepEqual(await repository.peek(), item);
  });

  test('missing queue item status update fails deterministically without insert', async () => {
    const repository = createRepository();

    await repository.enqueue(createItem());

    await assert.rejects(
      () => repository.updateStatus('missing-execution', 'processing'),
      /Durable translation execution queue item missing-execution was not found/
    );

    assert.equal(await repository.size(), 1);
  });

  test('acknowledge removes only the matching item and preserves FIFO ordering', async () => {
    const repository = createRepository();
    const first = createItem({ executionId: 'execution-1', requestId: 'request-1' });
    const second = createItem({ executionId: 'execution-2', requestId: 'request-2' });
    const third = createItem({ executionId: 'execution-3', requestId: 'request-3' });

    await repository.enqueue(first);
    await repository.enqueue(second);
    await repository.enqueue(third);
    const acknowledged = await repository.acknowledge('execution-2');

    assert.deepEqual(acknowledged, second);
    assert.equal(Object.isFrozen(acknowledged), true);
    assert.deepEqual(await repository.list(), [first, third]);
    assert.equal(await repository.size(), 2);
  });

  test('acknowledge removes an item exactly once and missing items fail deterministically', async () => {
    const repository = createRepository();

    await repository.enqueue(createItem());
    await repository.acknowledge('execution-1');

    assert.deepEqual(await repository.list(), []);
    await assert.rejects(
      () => repository.acknowledge('execution-1'),
      (error) => error instanceof Error
        && error.code === TRANSLATION_EXECUTION_QUEUE_ITEM_NOT_FOUND_CODE
    );
  });

  test('acknowledge rejects invalid execution IDs without changing repository state', async () => {
    const repository = createRepository();
    const item = createItem();

    await repository.enqueue(item);

    for (const executionId of [null, undefined, '', '   ', 1, false, {}]) {
      await assert.rejects(
        () => repository.acknowledge(executionId),
        (error) => error instanceof TypeError && error.code === INVALID_TRANSLATION_EXECUTION_QUEUE_ITEM_CODE
      );
    }

    assert.deepEqual(await repository.list(), [item]);
  });

  test('contains returns whether an execution exists without changing storage', async () => {
    const repository = createRepository();
    const item = createItem();

    await repository.enqueue(item);

    assert.equal(await repository.contains('execution-1'), true);
    assert.equal(await repository.contains('missing-execution'), false);
    assert.deepEqual(await repository.list(), [item]);
  });

  test('same identity enqueue is idempotent and preserves item fields status and FIFO ordering', async () => {
    const repository = createRepository();
    const items = Object.values(DURABLE_TRANSLATION_EXECUTION_QUEUE_ITEM_STATUSES).map((status, index) =>
      createItem({
        executionId: `execution-${index + 1}`,
        requestId: `request-${index + 1}`,
        status,
        leasedUntil: status === 'processing' ? '2026-07-17T08:05:00.000Z' : null
      })
    );

    for (const item of items) {
      await repository.enqueue(item);
      await repository.enqueue({
        ...item,
        enqueuedAt: '2026-07-17T09:00:00.000Z',
        status: 'queued',
        leasedUntil: null
      });
    }

    assert.deepEqual(await repository.list(), items);
    assert.equal(await repository.size(), items.length);
  });

  test('execution identity conflicts reject deterministically without changing FIFO state', async () => {
    const repository = createRepository();
    const first = createItem({ executionId: 'execution-1', requestId: 'request-1' });
    const conflicting = createItem({ executionId: 'execution-1', requestId: 'other-request' });
    const second = createItem({ executionId: 'execution-2', requestId: 'request-2' });

    await repository.enqueue(first);
    await repository.enqueue(second);

    await assert.rejects(
      () => repository.enqueue(conflicting),
      (error) => error instanceof Error && error.code === TRANSLATION_EXECUTION_QUEUE_ITEM_CONFLICT_CODE
    );

    assert.deepEqual(await repository.list(), [first, second]);
  });

  test('an acknowledged execution can be enqueued again', async () => {
    const repository = createRepository();
    const item = createItem();

    await repository.enqueue(item);
    await repository.acknowledge(item.executionId);
    await repository.enqueue(item);

    assert.deepEqual(await repository.list(), [item]);
  });

  test('claim persists a lease and expired leases can be released without reordering', async () => {
    const repository = createRepository();
    const first = createItem({ executionId: 'execution-1', requestId: 'request-1' });
    const second = createItem({ executionId: 'execution-2', requestId: 'request-2' });
    const lease = '2026-07-17T08:05:00.000Z';

    await repository.enqueue(first);
    await repository.enqueue(second);
    await repository.claim('execution-1', lease);
    assert.equal(await repository.isLeaseExpired('execution-1', '2026-07-17T08:04:59.999Z'), false);
    assert.equal(await repository.isLeaseExpired('execution-1', lease), true);
    assert.equal(await repository.releaseExpired(lease), 1);
    assert.deepEqual(await repository.list(), [first, second]);
  });

  test('releaseExpired preserves terminal item leases', async () => {
    const repository = createRepository();
    const lease = '2026-07-17T08:05:00.000Z';
    const processing = createItem({
      executionId: 'execution-processing',
      requestId: 'request-processing',
      status: 'processing',
      leasedUntil: lease
    });
    const completed = createItem({
      executionId: 'execution-completed',
      requestId: 'request-completed',
      status: 'completed',
      leasedUntil: lease
    });
    const failed = createItem({
      executionId: 'execution-failed',
      requestId: 'request-failed',
      status: 'failed',
      leasedUntil: lease
    });

    await repository.enqueue(processing);
    await repository.enqueue(completed);
    await repository.enqueue(failed);

    assert.equal(await repository.releaseExpired(lease), 1);
    assert.deepEqual(await repository.list(), [
      { ...processing, leasedUntil: null },
      completed,
      failed
    ]);
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
    status: 'queued',
    leasedUntil: null,
    ...overrides
  };
}

function createItemWithoutStatus(overrides = {}) {
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
