import assert from 'node:assert/strict';
import { promises as fileSystem } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createFileDeadLetterQueueRepository,
  INVALID_DEAD_LETTER_QUEUE_STORAGE_CODE
} from '../../src/infrastructure/fileDeadLetterQueueRepository.js';
import { createItem, runDeadLetterQueueRepositoryContract } from './deadLetterQueueRepositoryContract.test.js';

let fileCounter = 0;

runDeadLetterQueueRepositoryContract({
  createRepository() {
    return createRepository({ filePath: temporaryFilePath() });
  }
});

test('file-backed dead-letter queue writes deterministic JSON and survives reload', async () => {
  const filePath = temporaryFilePath();
  const first = createRepository({ filePath });
  const item = createItem();
  await first.enqueue(item);

  assert.equal(
    await fileSystem.readFile(filePath, 'utf8'),
    `${JSON.stringify({ items: [item] }, null, 2)}\n`
  );
  assert.deepEqual(await createRepository({ filePath }).list(), [item]);
});

test('invalid persisted dead-letter item throws deterministic storage error', async () => {
  const filePath = temporaryFilePath();
  await fileSystem.writeFile(filePath, `${JSON.stringify({ items: [createItem({ attempt: -1 })] })}\n`, 'utf8');

  await assert.rejects(
    () => createRepository({ filePath }).list(),
    (error) => error instanceof Error && error.code === INVALID_DEAD_LETTER_QUEUE_STORAGE_CODE
  );
});

function createRepository({ filePath }) {
  return createFileDeadLetterQueueRepository({ fileSystem, filePath });
}

function temporaryFilePath() {
  fileCounter += 1;
  return join(tmpdir(), `live-translate-file-dead-letter-queue-${process.pid}-${Date.now()}-${fileCounter}.json`);
}
