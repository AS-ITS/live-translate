import assert from 'node:assert/strict';
import test from 'node:test';
import { createDualWriteTranslationExecutionQueue } from '../../src/infrastructure/dualWriteTranslationExecutionQueue.js';
import { createFakeDurableTranslationExecutionQueueRepository } from '../../src/infrastructure/fakeDurableTranslationExecutionQueueRepository.js';
import { createInMemoryTranslationExecutionQueue } from '../../src/infrastructure/inMemoryTranslationExecutionQueue.js';

test('enqueue writes durable repository before primary queue', async () => {
  const calls = [];
  const queue = createDualWriteTranslationExecutionQueue({
    primaryQueue: primaryQueue({
      enqueue(item) {
        calls.push(['primary.enqueue', item]);
      }
    }),
    durableRepository: durableRepository({
      contains() {
        calls.push(['durable.contains']);
        return false;
      },
      enqueue(item) {
        calls.push(['durable.enqueue', item]);
      }
    }),
    clock: fixedClock()
  });

  await queue.enqueue(createItem());

  assert.deepEqual(calls.map(([name]) => name), ['durable.contains', 'durable.enqueue', 'primary.enqueue']);
});

test('duplicate durable execution is a successful no-op without primary enqueue', async () => {
  const calls = [];
  const queue = createDualWriteTranslationExecutionQueue({
    primaryQueue: primaryQueue({
      enqueue() {
        calls.push(['primary.enqueue']);
      }
    }),
    durableRepository: durableRepository({
      contains() {
        calls.push(['durable.contains']);
        return true;
      },
      enqueue() {
        calls.push(['durable.enqueue']);
      }
    }),
    clock: fixedClock()
  });

  await queue.enqueue(createItem());

  assert.deepEqual(calls.map(([name]) => name), ['durable.contains']);
});

test('durable enqueue succeeds while duplicate active enqueue preserves one primary item', async () => {
  const primaryQueue = createInMemoryTranslationExecutionQueue();
  const durableRepository = createFakeDurableTranslationExecutionQueueRepository();
  const item = createItem();
  primaryQueue.enqueue(item);

  const queue = createDualWriteTranslationExecutionQueue({
    primaryQueue,
    durableRepository,
    clock: fixedClock()
  });

  await queue.enqueue(item);

  assert.equal(await durableRepository.size(), 1);
  assert.equal(primaryQueue.size(), 1);
  assert.strictEqual(primaryQueue.dequeue(), item);
});

test('contains failure prevents durable and primary enqueue and propagates unchanged', async () => {
  const containsError = new Error('contains failed');
  const queue = createDualWriteTranslationExecutionQueue({
    primaryQueue: primaryQueue({
      enqueue() {
        throw new Error('primary enqueue should not run');
      }
    }),
    durableRepository: durableRepository({
      contains() {
        throw containsError;
      },
      enqueue() {
        throw new Error('durable enqueue should not run');
      }
    }),
    clock: fixedClock()
  });

  await assert.rejects(queue.enqueue(createItem()), (error) => error === containsError);
});

test('durable item contains executionId requestId and clock enqueuedAt', async () => {
  const durableItems = [];
  const queue = createDualWriteTranslationExecutionQueue({
    primaryQueue: primaryQueue(),
    durableRepository: durableRepository({
      enqueue(item) {
        durableItems.push(item);
      }
    }),
    clock: fixedClock('2026-07-17T09:10:11.000Z')
  });

  await queue.enqueue(createItem({ executionId: 'execution-2', requestId: 'request-2' }));

  assert.deepEqual(durableItems, [
    {
      executionId: 'execution-2',
      requestId: 'request-2',
      enqueuedAt: '2026-07-17T09:10:11.000Z',
      status: 'queued'
    }
  ]);
});

test('primary queue receives original queue item schema', async () => {
  const primaryItems = [];
  const queue = createDualWriteTranslationExecutionQueue({
    primaryQueue: primaryQueue({
      enqueue(item) {
        primaryItems.push(item);
      }
    }),
    durableRepository: durableRepository(),
    clock: fixedClock()
  });

  await queue.enqueue(createItem({ extra: 'ignored' }));

  assert.deepEqual(primaryItems, [
    {
      executionId: 'execution-1',
      requestId: 'request-1'
    }
  ]);
});

test('enqueue does not modify the input item', async () => {
  const queue = createDualWriteTranslationExecutionQueue({
    primaryQueue: primaryQueue(),
    durableRepository: durableRepository(),
    clock: fixedClock()
  });
  const item = createItem({ metadata: { source: 'test' } });
  const before = structuredClone(item);

  await queue.enqueue(item);

  assert.deepEqual(item, before);
});

test('durable failure does not call primary enqueue and rethrows original error', async () => {
  const durableError = new Error('durable failed');
  let primaryEnqueueCalls = 0;
  const queue = createDualWriteTranslationExecutionQueue({
    primaryQueue: primaryQueue({
      enqueue() {
        primaryEnqueueCalls += 1;
      }
    }),
    durableRepository: durableRepository({
      enqueue() {
        throw durableError;
      }
    }),
    clock: fixedClock()
  });

  await assert.rejects(queue.enqueue(createItem()), (error) => error === durableError);
  assert.equal(primaryEnqueueCalls, 0);
});

test('primary failure rethrows original error and keeps durable item', async () => {
  const primaryError = new Error('primary failed');
  const durableItems = [];
  const queue = createDualWriteTranslationExecutionQueue({
    primaryQueue: primaryQueue({
      enqueue() {
        throw primaryError;
      }
    }),
    durableRepository: durableRepository({
      enqueue(item) {
        durableItems.push(item);
      }
    }),
    clock: fixedClock()
  });

  await assert.rejects(queue.enqueue(createItem()), (error) => error === primaryError);
  assert.deepEqual(durableItems, [
    {
      executionId: 'execution-1',
      requestId: 'request-1',
      enqueuedAt: '2026-07-17T08:00:00.000Z',
      status: 'queued'
    }
  ]);
});

test('dequeue delegates to primary queue only', () => {
  const item = createItem();
  let durableDequeueCalls = 0;
  const queue = createDualWriteTranslationExecutionQueue({
    primaryQueue: primaryQueue({
      dequeue() {
        return item;
      }
    }),
    durableRepository: durableRepository({
      dequeue() {
        durableDequeueCalls += 1;
      }
    }),
    clock: fixedClock()
  });

  assert.strictEqual(queue.dequeue(), item);
  assert.equal(durableDequeueCalls, 0);
});

test('size delegates to primary queue only', () => {
  let durableSizeCalls = 0;
  const queue = createDualWriteTranslationExecutionQueue({
    primaryQueue: primaryQueue({
      size() {
        return 7;
      }
    }),
    durableRepository: durableRepository({
      size() {
        durableSizeCalls += 1;
      }
    }),
    clock: fixedClock()
  });

  assert.equal(queue.size(), 7);
  assert.equal(durableSizeCalls, 0);
});

function createItem(overrides = {}) {
  return {
    executionId: 'execution-1',
    requestId: 'request-1',
    ...overrides
  };
}

function fixedClock(timestamp = '2026-07-17T08:00:00.000Z') {
  return {
    now() {
      return timestamp;
    }
  };
}

function primaryQueue(overrides = {}) {
  const items = [];

  return {
    enqueue:
      overrides.enqueue ||
      function enqueue(item) {
        items.push(item);
      },
    dequeue:
      overrides.dequeue ||
      function dequeue() {
        return items.shift() ?? null;
      },
    size:
      overrides.size ||
      function size() {
        return items.length;
      }
  };
}

function durableRepository(overrides = {}) {
  const items = [];

  return {
    enqueue:
      overrides.enqueue ||
      function enqueue(item) {
        items.push(item);
      },
    dequeue:
      overrides.dequeue ||
      function dequeue() {
        return items.shift() ?? null;
      },
    peek:
      overrides.peek ||
      function peek() {
        return items[0] ?? null;
      },
    list:
      overrides.list ||
      function list() {
        return [...items];
      },
    size:
      overrides.size ||
      function size() {
        return items.length;
      },
    clear:
      overrides.clear ||
      function clear() {
        items.length = 0;
      },
    updateStatus:
      overrides.updateStatus ||
      function updateStatus() {
        throw new Error('dual-write queue should not update durable status');
      },
    acknowledge:
      overrides.acknowledge ||
      function acknowledge() {
        throw new Error('dual-write queue should not acknowledge durable items');
      },
    contains:
      overrides.contains ||
      function contains(executionId) {
        return items.some((item) => item.executionId === executionId);
      },
    claim() {},
    releaseExpired() { return 0; },
    isLeaseExpired() { return false; },
    renewLease() {}
  };
}
