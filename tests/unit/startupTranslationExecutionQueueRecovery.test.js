import assert from 'node:assert/strict';
import test from 'node:test';
import { createStartupTranslationExecutionQueueRecovery } from '../../src/application/translation/startupTranslationExecutionQueueRecovery.js';
import {
  DURABLE_TRANSLATION_EXECUTION_QUEUE_ITEM_STATUSES,
  TRANSLATION_EXECUTION_QUEUE_ITEM_CONFLICT_CODE
} from '../../src/application/translation/durableTranslationExecutionQueueRepository.js';
import { createFakeDurableTranslationExecutionQueueRepository } from '../../src/infrastructure/fakeDurableTranslationExecutionQueueRepository.js';
import { createInMemoryTranslationExecutionQueue } from '../../src/infrastructure/inMemoryTranslationExecutionQueue.js';

test('empty repository completes without enqueue or dequeue', async () => {
  const calls = [];
  const recovery = createStartupTranslationExecutionQueueRecovery({
    durableRepository: durableRepository({ calls }),
    activeQueue: activeQueue({ calls })
  });

  await recovery.recover();

  assert.deepEqual(calls, [['durable.list']]);
});

test('replays a single item into active queue and keeps durable item for worker claim', async () => {
  const repository = durableRepository({
    items: [durableItem({ executionId: 'execution-1', requestId: 'request-1' })]
  });
  const queue = activeQueue();
  const recovery = createStartupTranslationExecutionQueueRecovery({
    durableRepository: repository,
    activeQueue: queue
  });

  await recovery.recover();

  assert.deepEqual(queue.items, [{ executionId: 'execution-1', requestId: 'request-1' }]);
  assert.equal(await repository.size(), 1);
});

test('replays multiple items in FIFO order', async () => {
  const repository = durableRepository({
    items: [
      durableItem({ executionId: 'execution-1', requestId: 'request-1' }),
      durableItem({ executionId: 'execution-2', requestId: 'request-2' }),
      durableItem({ executionId: 'execution-3', requestId: 'request-3' })
    ]
  });
  const queue = activeQueue();
  const recovery = createStartupTranslationExecutionQueueRecovery({
    durableRepository: repository,
    activeQueue: queue
  });

  await recovery.recover();

  assert.deepEqual(queue.items, [
    { executionId: 'execution-1', requestId: 'request-1' },
    { executionId: 'execution-2', requestId: 'request-2' },
    { executionId: 'execution-3', requestId: 'request-3' }
  ]);
});

test('replay operations preserve item order', async () => {
  const calls = [];
  const recovery = createStartupTranslationExecutionQueueRecovery({
    durableRepository: durableRepository({
      calls,
      items: [
        durableItem({ executionId: 'execution-1', requestId: 'request-1' }),
        durableItem({ executionId: 'execution-2', requestId: 'request-2' })
      ]
    }),
    activeQueue: activeQueue({ calls })
  });

  await recovery.recover();

  assert.deepEqual(calls, [
    ['durable.list'],
    ['active.enqueue', { executionId: 'execution-1', requestId: 'request-1' }],
    ['active.enqueue', { executionId: 'execution-2', requestId: 'request-2' }]
  ]);
});

test('active enqueue receives queue schema without enqueuedAt', async () => {
  const queueItems = [];
  const recovery = createStartupTranslationExecutionQueueRecovery({
    durableRepository: durableRepository({
      items: [durableItem({ executionId: 'execution-1', requestId: 'request-1' })]
    }),
    activeQueue: activeQueue({
      enqueue(item) {
        queueItems.push(item);
      }
    })
  });

  await recovery.recover();

  assert.deepEqual(queueItems, [{ executionId: 'execution-1', requestId: 'request-1' }]);
  assert.equal(Object.hasOwn(queueItems[0], 'enqueuedAt'), false);
});

test('replay completion leaves durable repository intact for future acknowledgement', async () => {
  const repository = durableRepository({
    items: [
      durableItem({ executionId: 'execution-1', requestId: 'request-1' }),
      durableItem({ executionId: 'execution-2', requestId: 'request-2' })
    ]
  });
  const recovery = createStartupTranslationExecutionQueueRecovery({
    durableRepository: repository,
    activeQueue: activeQueue()
  });

  await recovery.recover();

  assert.equal(await repository.size(), 2);
  assert.deepEqual(await repository.peek(), durableItem({ executionId: 'execution-1', requestId: 'request-1' }));
});

test('repeated recovery is idempotent and preserves FIFO active queue ordering', async () => {
  const repository = durableRepository({
    items: [
      durableItem({ executionId: 'execution-1', requestId: 'request-1' }),
      durableItem({ executionId: 'execution-2', requestId: 'request-2' })
    ]
  });
  const queue = activeQueue();
  const recovery = createStartupTranslationExecutionQueueRecovery({ durableRepository: repository, activeQueue: queue });

  await recovery.recover();
  await recovery.recover();

  assert.deepEqual(queue.items, [
    { executionId: 'execution-1', requestId: 'request-1' },
    { executionId: 'execution-2', requestId: 'request-2' }
  ]);
  assert.equal(await repository.size(), 2);
});

test('separate recovery instances do not duplicate active queue items', async () => {
  const repository = durableRepository({
    items: [durableItem({ executionId: 'execution-1', requestId: 'request-1' })]
  });
  const queue = createInMemoryTranslationExecutionQueue();

  await createStartupTranslationExecutionQueueRecovery({ durableRepository: repository, activeQueue: queue }).recover();
  await createStartupTranslationExecutionQueueRecovery({ durableRepository: repository, activeQueue: queue }).recover();

  assert.equal(queue.size(), 1);
  assert.deepEqual(queue.dequeue(), { executionId: 'execution-1', requestId: 'request-1' });
});

test('completed and failed durable items are not replayed or changed', async () => {
  const repository = createFakeDurableTranslationExecutionQueueRepository();
  const queued = durableItem({
    executionId: 'execution-1',
    requestId: 'request-1',
    status: 'queued',
    leasedUntil: null
  });
  const completed = durableItem({
    executionId: 'execution-2',
    requestId: 'request-2',
    status: DURABLE_TRANSLATION_EXECUTION_QUEUE_ITEM_STATUSES.COMPLETED,
    leasedUntil: '2026-07-17T07:00:00.000Z'
  });
  const failed = durableItem({
    executionId: 'execution-3',
    requestId: 'request-3',
    status: DURABLE_TRANSLATION_EXECUTION_QUEUE_ITEM_STATUSES.FAILED,
    leasedUntil: '2026-07-17T07:00:00.000Z'
  });
  const queue = createInMemoryTranslationExecutionQueue();

  await repository.enqueue(queued);
  await repository.enqueue(completed);
  await repository.enqueue(failed);

  await createStartupTranslationExecutionQueueRecovery({
    durableRepository: repository,
    activeQueue: queue,
    clock: () => '2026-07-17T08:00:00.000Z'
  }).recover();

  assert.deepEqual(queue.dequeue(), { executionId: queued.executionId, requestId: queued.requestId });
  assert.equal(queue.dequeue(), null);
  assert.deepEqual(await repository.list(), [queued, completed, failed]);
});

test('expired processing item replays without resetting its status', async () => {
  const repository = createFakeDurableTranslationExecutionQueueRepository();
  const item = durableItem({
    status: DURABLE_TRANSLATION_EXECUTION_QUEUE_ITEM_STATUSES.PROCESSING,
    leasedUntil: '2026-07-17T07:00:00.000Z'
  });
  const queue = createInMemoryTranslationExecutionQueue();
  await repository.enqueue(item);

  await createStartupTranslationExecutionQueueRecovery({
    durableRepository: repository,
    activeQueue: queue,
    clock: () => '2026-07-17T08:00:00.000Z'
  }).recover();

  assert.deepEqual(queue.dequeue(), { executionId: item.executionId, requestId: item.requestId });
  assert.deepEqual(await repository.list(), [{ ...item, leasedUntil: null }]);
});

test('conflicting persisted durable execution identity fails before active enqueue or lease release', async () => {
  const queue = activeQueue();
  const calls = [];
  const recovery = createStartupTranslationExecutionQueueRecovery({
    durableRepository: durableRepository({
      calls,
      items: [
        durableItem({ executionId: 'execution-1', requestId: 'request-1' }),
        durableItem({ executionId: 'execution-1', requestId: 'duplicate-request' }),
        durableItem({ executionId: 'execution-2', requestId: 'request-2' })
      ]
    }),
    activeQueue: queue
  });

  await assert.rejects(
    recovery.recover(),
    (error) => error instanceof Error && error.code === TRANSLATION_EXECUTION_QUEUE_ITEM_CONFLICT_CODE
  );

  assert.deepEqual(queue.items, []);
  assert.deepEqual(calls, [['durable.list']]);
});

test('active enqueue failure stops recovery without durable dequeue and rethrows original error', async () => {
  const enqueueError = new Error('enqueue failed');
  const calls = [];
  const repository = durableRepository({
    calls,
    items: [durableItem({ executionId: 'execution-1', requestId: 'request-1' })]
  });
  const recovery = createStartupTranslationExecutionQueueRecovery({
    durableRepository: repository,
    activeQueue: activeQueue({
      calls,
      enqueue() {
        calls.push(['active.enqueue']);
        throw enqueueError;
      }
    })
  });

  await assert.rejects(recovery.recover(), (error) => error === enqueueError);
  assert.deepEqual(calls, [['durable.list'], ['active.enqueue']]);
  assert.equal(await repository.size(), 1);
});

test('list failure rethrows original error', async () => {
  const listError = new Error('list failed');
  const recovery = createStartupTranslationExecutionQueueRecovery({
    durableRepository: durableRepository({
      list() {
        throw listError;
      }
    }),
    activeQueue: activeQueue()
  });

  await assert.rejects(recovery.recover(), (error) => error === listError);
});

function durableItem(overrides = {}) {
  return {
    executionId: 'execution-1',
    requestId: 'request-1',
    enqueuedAt: '2026-07-17T08:00:00.000Z',
    ...overrides
  };
}

function durableRepository(overrides = {}) {
  const items = [...(overrides.items ?? [])];
  const calls = overrides.calls;

  return {
    enqueue() {
      throw new Error('recovery should not enqueue durable repository');
    },
    async peek() {
      calls?.push(['durable.peek']);
      return overrides.peek ? overrides.peek() : (items[0] ?? null);
    },
    async list() {
      calls?.push(['durable.list']);
      return overrides.list ? overrides.list() : [...items];
    },
    async dequeue() {
      if (overrides.dequeue) {
        return overrides.dequeue();
      }
      calls?.push(['durable.dequeue']);
      return items.shift() ?? null;
    },
    async size() {
      return items.length;
    },
    async clear() {
      throw new Error('recovery should not clear durable repository');
    },
    async updateStatus() {
      throw new Error('recovery should not update durable status');
    },
    async acknowledge() {
      throw new Error('recovery should not acknowledge durable items');
    },
    async contains() {
      throw new Error('recovery should not query durable item existence');
    },
    async claim() { throw new Error('recovery should not claim'); },
    async releaseExpired() { return 0; },
    async isLeaseExpired() { return false; },
    async renewLease() { throw new Error('recovery should not renew leases'); }
  };
}

function activeQueue(overrides = {}) {
  const items = [];
  const calls = overrides.calls;

  return {
    items,
    enqueue:
      overrides.enqueue ||
      function enqueue(item) {
        calls?.push(['active.enqueue', item]);
        items.push(item);
      },
    dequeue() {
      return items.shift() ?? null;
    },
    size() {
      return items.length;
    }
  };
}
