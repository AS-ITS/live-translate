import assert from 'node:assert/strict';
import test from 'node:test';
import { createStartupTranslationExecutionQueueRecovery } from '../../src/application/translation/startupTranslationExecutionQueueRecovery.js';

test('empty repository completes without enqueue or dequeue', async () => {
  const calls = [];
  const recovery = createStartupTranslationExecutionQueueRecovery({
    durableRepository: durableRepository({ calls }),
    activeQueue: activeQueue({ calls })
  });

  await recovery.recover();

  assert.deepEqual(calls, [['durable.peek']]);
});

test('replays a single item into active queue and removes durable item', async () => {
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
  assert.equal(await repository.size(), 0);
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
    ['durable.peek'],
    ['active.enqueue', { executionId: 'execution-1', requestId: 'request-1' }],
    ['durable.dequeue'],
    ['durable.peek'],
    ['active.enqueue', { executionId: 'execution-2', requestId: 'request-2' }],
    ['durable.dequeue'],
    ['durable.peek']
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

test('replay completion leaves durable repository empty', async () => {
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

  assert.equal(await repository.size(), 0);
  assert.equal(await repository.peek(), null);
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
  assert.deepEqual(calls, [['durable.peek'], ['active.enqueue']]);
  assert.equal(await repository.size(), 1);
});

test('durable dequeue failure stops recovery and rethrows original error without rollback', async () => {
  const dequeueError = new Error('dequeue failed');
  const calls = [];
  const queue = activeQueue({ calls });
  const recovery = createStartupTranslationExecutionQueueRecovery({
    durableRepository: durableRepository({
      calls,
      items: [durableItem({ executionId: 'execution-1', requestId: 'request-1' })],
      dequeue() {
        calls.push(['durable.dequeue']);
        throw dequeueError;
      }
    }),
    activeQueue: queue
  });

  await assert.rejects(recovery.recover(), (error) => error === dequeueError);
  assert.deepEqual(queue.items, [{ executionId: 'execution-1', requestId: 'request-1' }]);
});

test('durable dequeue failure leaves durable item for future replay', async () => {
  const dequeueError = new Error('dequeue failed');
  const repository = durableRepository({
    items: [durableItem({ executionId: 'execution-1', requestId: 'request-1' })],
    dequeue() {
      throw dequeueError;
    }
  });
  const recovery = createStartupTranslationExecutionQueueRecovery({
    durableRepository: repository,
    activeQueue: activeQueue()
  });

  await assert.rejects(recovery.recover(), (error) => error === dequeueError);

  assert.equal(await repository.size(), 1);
});

test('peek failure rethrows original error', async () => {
  const peekError = new Error('peek failed');
  const recovery = createStartupTranslationExecutionQueueRecovery({
    durableRepository: durableRepository({
      peek() {
        throw peekError;
      }
    }),
    activeQueue: activeQueue()
  });

  await assert.rejects(recovery.recover(), (error) => error === peekError);
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
