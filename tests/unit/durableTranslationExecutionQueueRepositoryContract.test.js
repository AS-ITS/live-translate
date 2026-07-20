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
    const item = createDurableTranslationExecutionQueueItem(createProcessingItem());

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
      { executionId: 'execution-1', requestId: 'request-1', enqueuedAt: enqueuedAt(), status: 1 },
      createItem({ leaseId: 'lease-1' }),
      createItem({ claimedAt: claimedAt() }),
      createItem({ leaseExpiresAt: leaseExpiresAt() }),
      createItem({ status: 'processing' }),
      createItem({ status: 'processing', leaseId: 'lease-1', claimedAt: claimedAt() }),
      createItem({ status: 'processing', ...lease({ claimedAt: leaseExpiresAt(), leaseExpiresAt: claimedAt() }) })
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

  test('claim atomically changes queued items to processing with lease metadata', async () => {
    const repository = createRepository();
    const itemLease = lease();

    await repository.enqueue(createItem());
    await repository.claim('execution-1', itemLease);
    assert.deepEqual(await repository.peek(), createProcessingItem(itemLease));
  });

  test('terminal status transitions clear processing lease metadata', async () => {
    const repository = createRepository();

    await repository.enqueue(createItem());
    await repository.claim('execution-1', lease());
    await repository.updateStatus('execution-1', 'completed');
    assert.deepEqual(await repository.peek(), createItem({ status: 'completed' }));

    await repository.clear();
    await repository.enqueue(createItem());
    await repository.claim('execution-1', lease());
    await repository.updateStatus('execution-1', 'failed');
    assert.deepEqual(await repository.peek(), createItem({ status: 'failed' }));
  });

  test('status update preserves identity payload item count and queue ordering', async () => {
    const repository = createRepository();
    const first = createItem({ executionId: 'execution-1', requestId: 'request-1' });
    const second = createItem({ executionId: 'execution-2', requestId: 'request-2' });
    const third = createItem({ executionId: 'execution-3', requestId: 'request-3' });

    await repository.enqueue(first);
    await repository.enqueue(second);
    await repository.enqueue(third);
    const secondLease = lease();
    await repository.claim('execution-2', secondLease);

    assert.equal(await repository.size(), 3);
    assert.deepEqual(await repository.dequeue(), first);
    assert.deepEqual(await repository.dequeue(), createProcessingItem({
      executionId: second.executionId,
      requestId: second.requestId,
      enqueuedAt: second.enqueuedAt,
      ...secondLease
    }));
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
    const items = Object.values(DURABLE_TRANSLATION_EXECUTION_QUEUE_ITEM_STATUSES).map((status, index) => {
      const item = createItem({
        executionId: `execution-${index + 1}`,
        requestId: `request-${index + 1}`,
        status
      });
      return status === 'processing' ? createProcessingItem({ ...item, ...lease() }) : item;
    });

    for (const item of items) {
      await repository.enqueue(item);
      await repository.enqueue({
        executionId: item.executionId,
        requestId: item.requestId,
        enqueuedAt: '2026-07-17T09:00:00.000Z',
        status: 'queued'
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

  test('claim rejects missing items, non-queued items, and invalid leases without changing state', async () => {
    const repository = createRepository();
    const item = createItem();

    await assert.rejects(
      () => repository.claim('missing-execution', lease()),
      /Durable translation execution queue item missing-execution was not found/
    );
    await repository.enqueue(item);

    for (const invalidLease of [null, undefined, {}, { leaseId: '', claimedAt: claimedAt(), leaseExpiresAt: leaseExpiresAt() }, { leaseId: 'lease-1', claimedAt: claimedAt(), leaseExpiresAt: claimedAt() }]) {
      await assert.rejects(
        () => repository.claim(item.executionId, invalidLease),
        (error) => error instanceof TypeError && error.code === INVALID_TRANSLATION_EXECUTION_QUEUE_ITEM_CODE
      );
    }
    assert.deepEqual(await repository.peek(), item);

    await repository.claim(item.executionId, lease());
    await assert.rejects(
      () => repository.claim(item.executionId, lease()),
      (error) => error instanceof TypeError && error.code === INVALID_TRANSLATION_EXECUTION_QUEUE_ITEM_CODE
    );
    assert.deepEqual(await repository.peek(), createProcessingItem(lease()));
  });

  test('updateStatus cannot create a processing item without lease metadata', async () => {
    const repository = createRepository();
    const item = createItem();

    await repository.enqueue(item);
    await assert.rejects(
      () => repository.updateStatus(item.executionId, 'processing'),
      (error) => error instanceof TypeError && error.code === INVALID_TRANSLATION_EXECUTION_QUEUE_ITEM_CODE
    );
    assert.deepEqual(await repository.peek(), item);
  });

  test('expired processing lease requeues atomically and clears lease metadata', async () => {
    const repository = createRepository();
    const item = createItem();

    await repository.enqueue(item);
    await repository.claim(item.executionId, lease());

    assert.equal(await repository.requeueExpiredProcessing(item.executionId, '2026-07-17T08:04:59.999Z'), null);
    assert.deepEqual(await repository.peek(), createProcessingItem());

    assert.deepEqual(
      await repository.requeueExpiredProcessing(item.executionId, leaseExpiresAt()),
      item
    );
    assert.deepEqual(await repository.peek(), item);
  });

  test('expired processing recovery leaves non-processing items unchanged', async () => {
    const repository = createRepository();
    const queued = createItem();
    const completed = createItem({ executionId: 'execution-completed', requestId: 'request-completed', status: 'completed' });
    const failed = createItem({ executionId: 'execution-failed', requestId: 'request-failed', status: 'failed' });

    for (const item of [queued, completed, failed]) await repository.enqueue(item);

    for (const item of [queued, completed, failed]) {
      assert.equal(await repository.requeueExpiredProcessing(item.executionId, leaseExpiresAt()), null);
    }
    assert.equal(await repository.requeueExpiredProcessing('missing-execution', leaseExpiresAt()), null);
    assert.deepEqual(await repository.list(), [queued, completed, failed]);
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

function claimedAt() {
  return '2026-07-17T08:01:00.000Z';
}

function leaseExpiresAt() {
  return '2026-07-17T08:05:00.000Z';
}

function lease(overrides = {}) {
  return {
    leaseId: 'lease-1',
    claimedAt: claimedAt(),
    leaseExpiresAt: leaseExpiresAt(),
    ...overrides
  };
}

function createProcessingItem(overrides = {}) {
  return {
    ...createItem(),
    status: 'processing',
    ...lease(),
    ...overrides
  };
}
