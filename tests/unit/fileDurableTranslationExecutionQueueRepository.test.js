import assert from 'node:assert/strict';
import { promises as fileSystem } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { createFileDurableTranslationExecutionQueueRepository } from '../../src/infrastructure/fileDurableTranslationExecutionQueueRepository.js';
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
    ...overrides
  };
}
