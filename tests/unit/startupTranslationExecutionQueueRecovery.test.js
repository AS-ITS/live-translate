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

test('completed durable items remain while failed terminal items acknowledge without replay', async () => {
  const repository = createFakeDurableTranslationExecutionQueueRepository();
  const queued = durableItem({
    executionId: 'execution-1',
    requestId: 'request-1',
    status: 'queued'
  });
  const completed = durableItem({
    executionId: 'execution-2',
    requestId: 'request-2',
    status: DURABLE_TRANSLATION_EXECUTION_QUEUE_ITEM_STATUSES.COMPLETED
  });
  const failed = durableItem({
    executionId: 'execution-3',
    requestId: 'request-3',
    status: DURABLE_TRANSLATION_EXECUTION_QUEUE_ITEM_STATUSES.FAILED
  });
  const queue = createInMemoryTranslationExecutionQueue();

  await repository.enqueue(queued);
  await repository.enqueue(completed);
  await repository.enqueue(failed);

  await createStartupTranslationExecutionQueueRecovery({
    durableRepository: repository,
    activeQueue: queue,
    translationRepository: recoveryTranslationRepository({
      executions: new Map([
        [completed.executionId, { id: completed.executionId, status: 'completed' }],
        [failed.executionId, { id: failed.executionId, status: 'failed' }]
      ])
    }),
    clock: () => '2026-07-17T08:00:00.000Z'
  }).recover();

  assert.deepEqual(queue.dequeue(), { executionId: queued.executionId, requestId: queued.requestId });
  assert.equal(queue.dequeue(), null);
  assert.deepEqual(await repository.list(), [queued, completed]);
});

test('expired processing item is atomically requeued and replayed after queued FIFO items', async () => {
  const repository = createFakeDurableTranslationExecutionQueueRepository();
  const queued = durableItem({ executionId: 'execution-queued', requestId: 'request-queued' });
  const item = processingItem({ executionId: 'execution-processing', requestId: 'request-processing' });
  const queue = createInMemoryTranslationExecutionQueue();
  await repository.enqueue(queued);
  await repository.enqueue(item);

  await createStartupTranslationExecutionQueueRecovery({
    durableRepository: repository,
    activeQueue: queue,
    translationRepository: recoveryTranslationRepository({
      executions: new Map([[item.executionId, { status: 'queued' }]])
    }),
    clock: () => '2026-07-17T08:00:00.000Z'
  }).recover();

  assert.deepEqual(queue.dequeue(), { executionId: queued.executionId, requestId: queued.requestId });
  assert.deepEqual(queue.dequeue(), { executionId: item.executionId, requestId: item.requestId });
  assert.deepEqual(await repository.list(), [queued, durableItem({ executionId: item.executionId, requestId: item.requestId })]);
});

test('valid and legacy processing items remain stored without replay', async () => {
  const validProcessing = processingItem({ executionId: 'execution-processing', requestId: 'request-processing', leaseExpiresAt: '2026-07-17T09:00:00.000Z' });
  const legacyProcessing = durableItem({
    executionId: 'execution-legacy',
    requestId: 'request-legacy',
    status: DURABLE_TRANSLATION_EXECUTION_QUEUE_ITEM_STATUSES.PROCESSING
  });
  const queue = createInMemoryTranslationExecutionQueue();
  const repository = durableRepository({ items: [validProcessing, legacyProcessing] });

  await createStartupTranslationExecutionQueueRecovery({
    durableRepository: repository,
    activeQueue: queue,
    clock: () => '2026-07-17T08:00:00.000Z'
  }).recover();

  assert.equal(queue.size(), 0);
  assert.deepEqual(await repository.list(), [validProcessing, legacyProcessing]);
});

test('running execution with persisted output reconciles through the command service without active replay', async () => {
  const item = processingItem();
  const calls = [];
  const recovery = createStartupTranslationExecutionQueueRecovery({
    durableRepository: durableRepository({ calls, items: [item] }),
    activeQueue: activeQueue({ calls }),
    translationRepository: recoveryTranslationRepository({
      calls,
      executions: new Map([[item.executionId, { id: item.executionId, status: 'running', startedAt: 1000 }]]),
      outputs: new Map([[item.executionId, [{ id: 'output-1' }]]])
    }),
    translationCommandService: {
      updateTranslationExecution(input) {
        calls.push(['translationCommandService.updateTranslationExecution', input]);
      }
    },
    clock: () => '2026-07-17T08:00:00.000Z'
  });

  await recovery.recover();

  assert.deepEqual(calls, [
    ['durable.list'],
    ['translation.findExecutionById', item.executionId],
    ['translation.listTranslationOutputsByExecution', item.executionId],
    ['translationCommandService.updateTranslationExecution', {
      executionId: item.executionId,
      transition: 'complete',
      completedAt: 1000
    }],
    ['durable.updateStatus', item.executionId, 'completed'],
    ['durable.acknowledge', item.executionId]
  ]);
});

test('missing execution leaves expired processing durable item unchanged and rethrows the recovery error', async () => {
  const item = processingItem();
  const repository = createFakeDurableTranslationExecutionQueueRepository();
  const queue = createInMemoryTranslationExecutionQueue();
  await repository.enqueue(item);

  await assert.rejects(
    createStartupTranslationExecutionQueueRecovery({
      durableRepository: repository,
      activeQueue: queue,
      translationRepository: recoveryTranslationRepository(),
      clock: () => '2026-07-17T08:00:00.000Z'
    }).recover(),
    /TranslationExecution execution-1 was not found/
  );

  assert.equal(queue.size(), 0);
  assert.deepEqual(await repository.list(), [item]);
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
    status: DURABLE_TRANSLATION_EXECUTION_QUEUE_ITEM_STATUSES.QUEUED,
    ...overrides
  };
}

function processingItem(overrides = {}) {
  return {
    ...durableItem(),
    status: DURABLE_TRANSLATION_EXECUTION_QUEUE_ITEM_STATUSES.PROCESSING,
    leaseId: 'lease-1',
    claimedAt: '2026-07-17T06:00:00.000Z',
    leaseExpiresAt: '2026-07-17T07:00:00.000Z',
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
    async updateStatus(executionId, status) {
      calls?.push(['durable.updateStatus', executionId, status]);
      return overrides.updateStatus ? overrides.updateStatus(executionId, status) : undefined;
    },
    async acknowledge(executionId) {
      calls?.push(['durable.acknowledge', executionId]);
      return overrides.acknowledge ? overrides.acknowledge(executionId) : undefined;
    },
    async contains() {
      throw new Error('recovery should not query durable item existence');
    },
    async claim() { throw new Error('recovery should not claim'); },
    async requeueExpiredProcessing(executionId, now) {
      calls?.push(['durable.requeueExpiredProcessing', executionId, now]);
      return overrides.requeueExpiredProcessing
        ? overrides.requeueExpiredProcessing(executionId, now)
        : null;
    }
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

function recoveryTranslationRepository({ calls, executions = new Map(), outputs = new Map() } = {}) {
  return {
    findExecutionById(executionId) {
      calls?.push(['translation.findExecutionById', executionId]);
      return executions.get(executionId) ?? null;
    },
    listTranslationOutputsByExecution(executionId) {
      calls?.push(['translation.listTranslationOutputsByExecution', executionId]);
      return outputs.get(executionId) ?? [];
    },
    updateTranslationExecution(execution) {
      calls?.push(['translation.updateTranslationExecution', execution]);
      executions.set(execution.id, execution);
      return execution;
    }
  };
}
