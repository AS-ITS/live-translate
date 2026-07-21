import assert from 'node:assert/strict';
import { promises as fileSystem } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { createFileDurableTranslationExecutionQueueRepository } from '../../src/infrastructure/fileDurableTranslationExecutionQueueRepository.js';
import { TRANSLATION_EXECUTION_QUEUE_ITEM_CONFLICT_CODE } from '../../src/application/translation/durableTranslationExecutionQueueRepository.js';
import { runDurableQueueRepositoryContract } from './durableTranslationExecutionQueueRepositoryContract.test.js';

const INVALID_STORAGE_ERROR_CODE = 'invalid_translation_execution_queue_storage';

let fileCounter = 0;

runDurableQueueRepositoryContract({
  createRepository() {
    return createRepository({ filePath: temporaryFilePath() });
  }
});

test('creates new storage when file does not exist', async () => {
  const filePath = temporaryFilePath();
  const repository = createRepository({ filePath });

  assert.equal(await repository.size(), 0);
  assert.deepEqual(await readStorage(filePath), {
    items: []
  });
});

test('enqueue writes pretty deterministic JSON storage', async () => {
  const filePath = temporaryFilePath();
  const repository = createRepository({ filePath });
  const item = createItem();

  await repository.enqueue(item);

  assert.equal(
    await fileSystem.readFile(filePath, 'utf8'),
    `${JSON.stringify(
      {
        items: [item]
      },
      null,
      2
    )}\n`
  );
});

test('dequeue updates JSON storage', async () => {
  const filePath = temporaryFilePath();
  const repository = createRepository({ filePath });
  const first = createItem({ executionId: 'execution-1', requestId: 'request-1' });
  const second = createItem({ executionId: 'execution-2', requestId: 'request-2' });

  await repository.enqueue(first);
  await repository.enqueue(second);

  assert.deepEqual(await repository.dequeue(), first);
  assert.deepEqual(await readStorage(filePath), {
    items: [second]
  });
});

test('clear updates JSON storage', async () => {
  const filePath = temporaryFilePath();
  const repository = createRepository({ filePath });

  await repository.enqueue(createItem());
  await repository.clear();

  assert.deepEqual(await readStorage(filePath), {
    items: []
  });
});

test('recreated repository reads persisted queue data', async () => {
  const filePath = temporaryFilePath();
  const firstRepository = createRepository({ filePath });
  const item = createItem();

  await firstRepository.enqueue(item);

  const secondRepository = createRepository({ filePath });

  assert.equal(await secondRepository.size(), 1);
  assert.deepEqual(await secondRepository.peek(), item);
  assert.deepEqual(await secondRepository.dequeue(), item);
  assert.equal(await secondRepository.size(), 0);
});

test('updated status survives repository reload', async () => {
  const filePath = temporaryFilePath();
  const firstRepository = createRepository({ filePath });

  await firstRepository.enqueue(createItem());
  await firstRepository.claim('execution-1', lease());

  const secondRepository = createRepository({ filePath });

  assert.deepEqual(await secondRepository.peek(), createProcessingItem());
});

test('claim persists the processing lease metadata and returns the claimed item', async () => {
  const filePath = temporaryFilePath();
  const repository = createRepository({ filePath });
  const expected = createProcessingItem();

  await repository.enqueue(createItem());

  assert.deepEqual(await repository.claim('execution-1', lease()), expected);
  assert.deepEqual(await readStorage(filePath), { items: [expected] });
});

test('reclaim increments the persisted fenceToken after expired processing requeue', async () => {
  const filePath = temporaryFilePath();
  const firstRepository = createRepository({ filePath });

  await firstRepository.enqueue(createItem());
  await firstRepository.claim('execution-1', lease());
  await firstRepository.requeueExpiredProcessing('execution-1', '2026-07-17T08:05:00.000Z');

  const secondRepository = createRepository({ filePath });
  const reclaimed = await secondRepository.claim('execution-1', {
    leaseId: 'lease-2',
    leaseExpiresAt: '2026-07-17T08:10:00.000Z'
  });

  assert.deepEqual(reclaimed, createProcessingItem({
    fenceToken: 2,
    leaseId: 'lease-2',
    leaseExpiresAt: '2026-07-17T08:10:00.000Z'
  }));
  assert.equal((await readStorage(filePath)).items[0].fenceToken, 2);
});

test('legacy storage without a fenceToken loads as zero and claims as one', async () => {
  const filePath = temporaryFilePath();
  const repository = createRepository({ filePath });
  const legacyItem = createItem();
  delete legacyItem.fenceToken;
  await fileSystem.mkdir(dirname(filePath), { recursive: true });
  await fileSystem.writeFile(filePath, `${JSON.stringify({ items: [legacyItem] }, null, 2)}\n`, 'utf8');

  assert.deepEqual(await repository.peek(), createItem());
  assert.deepEqual(await repository.claim('execution-1', lease()), createProcessingItem());
  assert.equal((await readStorage(filePath)).items[0].fenceToken, 1);
});

test('renewClaim preserves processing item field order and survives reload', async () => {
  const filePath = temporaryFilePath();
  const firstRepository = createRepository({ filePath });
  const item = createItem();
  const itemLease = {
    leaseId: 'lease-1',
    claimedAt: '2026-07-17T08:01:00.000Z',
    leaseExpiresAt: '2026-07-17T08:05:00.000Z'
  };
  const expected = createProcessingItem({
    ...itemLease,
    leaseExpiresAt: '2026-07-17T08:10:00.000Z'
  });

  await firstRepository.enqueue(item);
  await firstRepository.claim(item.executionId, itemLease);
  await firstRepository.renewClaim(item.executionId, { leaseId: itemLease.leaseId }, {
    leaseExpiresAt: expected.leaseExpiresAt,
    now: '2026-07-17T08:04:00.000Z'
  });

  assert.equal(
    await fileSystem.readFile(filePath, 'utf8'),
    `${JSON.stringify({
      items: [{
        executionId: expected.executionId,
        requestId: expected.requestId,
        enqueuedAt: expected.enqueuedAt,
        status: expected.status,
        fenceToken: expected.fenceToken,
        leaseId: expected.leaseId,
        claimedAt: expected.claimedAt,
        leaseExpiresAt: expected.leaseExpiresAt
      }]
    }, null, 2)}\n`
  );
  assert.deepEqual(await createRepository({ filePath }).peek(), expected);
});

test('old-format processing storage renews without adding lease fields', async () => {
  const filePath = temporaryFilePath();
  const repository = createRepository({ filePath });
  const legacyProcessing = createProcessingItem();
  await fileSystem.mkdir(dirname(filePath), { recursive: true });
  await fileSystem.writeFile(filePath, `${JSON.stringify({ items: [legacyProcessing] }, null, 2)}\n`, 'utf8');

  await repository.renewClaim('execution-1', { leaseId: 'lease-1' }, {
    leaseExpiresAt: '2026-07-17T08:10:00.000Z',
    now: '2026-07-17T08:04:00.000Z'
  });

  assert.deepEqual(await readStorage(filePath), {
    items: [createProcessingItem({ leaseExpiresAt: '2026-07-17T08:10:00.000Z' })]
  });
});

test('renewal serialization omits lease metadata from non-processing items', async () => {
  const filePath = temporaryFilePath();
  const repository = createRepository({ filePath });

  await repository.enqueue(createItem());
  await repository.claim('execution-1', lease());
  await repository.updateStatus('execution-1', 'completed');

  assert.deepEqual(await readStorage(filePath), {
    items: [createItem({ status: 'completed', fenceToken: 1 })]
  });
});

test('lease-aware acknowledgement preserves file storage on ownership mismatch', async () => {
  const filePath = temporaryFilePath();
  const repository = createRepository({ filePath });

  await repository.enqueue(createItem());
  await repository.claim('execution-1', lease());
  const storageBeforeMismatch = await fileSystem.readFile(filePath, 'utf8');

  await assert.rejects(
    () => repository.acknowledgeClaim('execution-1', { leaseId: 'other-lease', fenceToken: 1 }),
    (error) => error instanceof TypeError && error.code === 'translation_execution_queue_lease_ownership_error'
  );

  assert.equal(await fileSystem.readFile(filePath, 'utf8'), storageBeforeMismatch);
  assert.deepEqual(await createRepository({ filePath }).peek(), createProcessingItem());

  assert.deepEqual(await repository.acknowledgeClaim('execution-1', { leaseId: 'lease-1', fenceToken: 1 }), createProcessingItem());
  assert.deepEqual(await readStorage(filePath), { items: [] });
});

test('acknowledgement persists removal and preserves remaining FIFO order after reload', async () => {
  const filePath = temporaryFilePath();
  const firstRepository = createRepository({ filePath });
  const first = createItem({ executionId: 'execution-1', requestId: 'request-1' });
  const second = createItem({ executionId: 'execution-2', requestId: 'request-2' });
  const third = createItem({ executionId: 'execution-3', requestId: 'request-3' });

  await firstRepository.enqueue(first);
  await firstRepository.enqueue(second);
  await firstRepository.enqueue(third);
  await firstRepository.acknowledge('execution-2');

  assert.deepEqual(await readStorage(filePath), { items: [first, third] });

  const secondRepository = createRepository({ filePath });
  assert.deepEqual(await secondRepository.list(), [first, third]);
});

test('same identity enqueue leaves persisted storage unchanged across repository reload', async () => {
  const filePath = temporaryFilePath();
  const firstRepository = createRepository({ filePath });
  const item = createProcessingItem();

  await firstRepository.enqueue(item);
  const beforeDuplicate = await fileSystem.readFile(filePath, 'utf8');
  await firstRepository.enqueue(createItem({
    enqueuedAt: '2026-07-17T09:00:00.000Z',
    status: 'queued'
  }));

  assert.equal(await fileSystem.readFile(filePath, 'utf8'), beforeDuplicate);

  const secondRepository = createRepository({ filePath });
  assert.deepEqual(await secondRepository.list(), [item]);
});

test('execution identity conflict remains deterministic after repository reload', async () => {
  const filePath = temporaryFilePath();
  const firstRepository = createRepository({ filePath });
  const item = createItem();

  await firstRepository.enqueue(item);

  const secondRepository = createRepository({ filePath });
  await assert.rejects(
    () => secondRepository.enqueue(createItem({ requestId: 'different-request' })),
    (error) => error instanceof Error && error.code === TRANSLATION_EXECUTION_QUEUE_ITEM_CONFLICT_CODE
  );

  assert.deepEqual(await secondRepository.list(), [item]);
});

test('contains on missing storage returns false without creating storage', async () => {
  const filePath = temporaryFilePath();
  const repository = createRepository({ filePath });

  assert.equal(await repository.contains('execution-1'), false);
  await assert.rejects(() => fileSystem.access(filePath), { code: 'ENOENT' });
});

test('persisted item without status loads as queued', async () => {
  const filePath = temporaryFilePath();
  const repository = createRepository({ filePath });

  await fileSystem.mkdir(dirname(filePath), { recursive: true });
  await fileSystem.writeFile(
    filePath,
    `${JSON.stringify(
      {
        items: [
          {
            executionId: 'execution-1',
            requestId: 'request-1',
            enqueuedAt: '2026-07-17T08:00:00.000Z'
          }
        ]
      },
      null,
      2
    )}\n`,
    'utf8'
  );

  assert.deepEqual(await repository.peek(), createItem());
});

test('persisted processing storage without lease metadata fails deterministic validation', async () => {
  const filePath = temporaryFilePath();
  const repository = createRepository({ filePath });
  const legacyProcessing = {
    executionId: 'execution-legacy',
    requestId: 'request-legacy',
    enqueuedAt: '2026-07-17T08:00:00.000Z',
    status: 'processing'
  };

  await fileSystem.mkdir(dirname(filePath), { recursive: true });
  await fileSystem.writeFile(filePath, `${JSON.stringify({ items: [legacyProcessing] }, null, 2)}\n`, 'utf8');

  await assert.rejects(() => repository.peek(), storageErrorMatcher);
});

test('persisted processing storage with invalid lease metadata fails deterministic validation', async () => {
  const filePath = temporaryFilePath();
  const repository = createRepository({ filePath });
  const invalidProcessing = {
    executionId: 'execution-legacy',
    requestId: 'request-legacy',
    enqueuedAt: '2026-07-17T08:00:00.000Z',
    status: 'processing',
    leaseId: 'lease-1',
    leaseExpiresAt: 'not-a-date'
  };

  await fileSystem.mkdir(dirname(filePath), { recursive: true });
  await fileSystem.writeFile(filePath, `${JSON.stringify({ items: [invalidProcessing] }, null, 2)}\n`, 'utf8');

  await assert.rejects(() => repository.peek(), storageErrorMatcher);
});

test('persisted malformed fenceToken fails deterministic storage validation', async () => {
  const filePath = temporaryFilePath();
  const repository = createRepository({ filePath });
  await fileSystem.mkdir(dirname(filePath), { recursive: true });
  await fileSystem.writeFile(
    filePath,
    `${JSON.stringify({ items: [createItem({ fenceToken: -1 })] }, null, 2)}\n`,
    'utf8'
  );

  await assert.rejects(() => repository.peek(), storageErrorMatcher);
});

test('expired processing requeue persists without lease metadata after reload', async () => {
  const filePath = temporaryFilePath();
  const firstRepository = createRepository({ filePath });

  await firstRepository.enqueue(createItem());
  await firstRepository.claim('execution-1', lease());
  assert.deepEqual(
    await firstRepository.requeueExpiredProcessing('execution-1', '2026-07-17T08:05:00.000Z'),
    createItem({ fenceToken: 1 })
  );

  const secondRepository = createRepository({ filePath });
  assert.deepEqual(await secondRepository.peek(), createItem({ fenceToken: 1 }));
  assert.deepEqual(await readStorage(filePath), { items: [createItem({ fenceToken: 1 })] });
});

test('legacy queued and terminal storage without lease metadata loads unchanged', async () => {
  const filePath = temporaryFilePath();
  const repository = createRepository({ filePath });
  const items = [
    createItem({ executionId: 'execution-queued', requestId: 'request-queued' }),
    createItem({ executionId: 'execution-completed', requestId: 'request-completed', status: 'completed' }),
    createItem({ executionId: 'execution-failed', requestId: 'request-failed', status: 'failed' })
  ];

  await fileSystem.mkdir(dirname(filePath), { recursive: true });
  await fileSystem.writeFile(filePath, `${JSON.stringify({ items }, null, 2)}\n`, 'utf8');

  assert.deepEqual(await repository.list(), items);
});

test('persisted item with invalid status throws deterministic storage error', async () => {
  const filePath = temporaryFilePath();
  const repository = createRepository({ filePath });

  await fileSystem.mkdir(dirname(filePath), { recursive: true });
  await fileSystem.writeFile(
    filePath,
    JSON.stringify(
      {
        items: [createItem({ status: 'unknown' })]
      },
      null,
      2
    ),
    'utf8'
  );

  await assert.rejects(() => repository.peek(), storageErrorMatcher);
});

test('invalid JSON storage throws deterministic storage error', async () => {
  const filePath = temporaryFilePath();
  const repository = createRepository({ filePath });

  await fileSystem.mkdir(dirname(filePath), { recursive: true });
  await fileSystem.writeFile(filePath, '{ invalid json', 'utf8');

  await assert.rejects(() => repository.size(), storageErrorMatcher);
});

test('storage without items array throws deterministic storage error', async () => {
  const filePath = temporaryFilePath();
  const repository = createRepository({ filePath });

  await fileSystem.mkdir(dirname(filePath), { recursive: true });
  await fileSystem.writeFile(filePath, JSON.stringify({ queued: [] }, null, 2), 'utf8');

  await assert.rejects(() => repository.peek(), storageErrorMatcher);
});

function createRepository({ filePath }) {
  return createFileDurableTranslationExecutionQueueRepository({
    fileSystem,
    filePath
  });
}

function temporaryFilePath() {
  fileCounter += 1;
  return join(tmpdir(), `live-translate-file-durable-queue-${process.pid}-${Date.now()}-${fileCounter}.json`);
}

async function readStorage(filePath) {
  return JSON.parse(await fileSystem.readFile(filePath, 'utf8'));
}

function storageErrorMatcher(error) {
  return error instanceof Error && error.code === INVALID_STORAGE_ERROR_CODE;
}

function createItem(overrides = {}) {
  return {
    executionId: 'execution-1',
    requestId: 'request-1',
    enqueuedAt: '2026-07-17T08:00:00.000Z',
    status: 'queued',
    fenceToken: 0,
    ...overrides
  };
}

function createProcessingItem(overrides = {}) {
  return {
    ...createItem(),
    status: 'processing',
    leaseId: 'lease-1',
    leaseExpiresAt: '2026-07-17T08:05:00.000Z',
    fenceToken: 1,
    ...overrides
  };
}

function lease() {
  return {
    leaseId: 'lease-1',
    leaseExpiresAt: '2026-07-17T08:05:00.000Z'
  };
}
