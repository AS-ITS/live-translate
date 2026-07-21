import { dirname } from 'node:path';
import {
  createDeadLetterQueueItem,
  createDeadLetterQueueRepository
} from '../application/translation/deadLetterQueueRepository.js';

export const INVALID_DEAD_LETTER_QUEUE_STORAGE_CODE = 'invalid_dead_letter_queue_storage';
const INITIAL_STORAGE = Object.freeze({ items: [] });

export function createFileDeadLetterQueueRepository({ fileSystem, filePath } = {}) {
  assertFileSystem(fileSystem);
  assertFilePath(filePath);

  return createDeadLetterQueueRepository({
    async enqueue(item) {
      const storage = await readStorage({ fileSystem, filePath });
      if (!storage.items.some((candidate) => candidate.executionId === item.executionId)) storage.items.push(createDeadLetterQueueItem(item));
      await writeStorage({ fileSystem, filePath, storage });
    },
    async list() {
      return (await readStorage({ fileSystem, filePath })).items;
    },
    async size() {
      return (await readStorage({ fileSystem, filePath })).items.length;
    },
    async clear() {
      await writeStorage({ fileSystem, filePath, storage: INITIAL_STORAGE });
    }
  });
}

async function readStorage({ fileSystem, filePath }) {
  await ensureStorageFile({ fileSystem, filePath });
  let parsed;
  try {
    parsed = JSON.parse(await fileSystem.readFile(filePath, 'utf8'));
  } catch {
    throwInvalidStorage();
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.items)) throwInvalidStorage();
  try {
    return { items: parsed.items.map((item) => createDeadLetterQueueItem(item)) };
  } catch {
    throwInvalidStorage();
  }
}

async function ensureStorageFile({ fileSystem, filePath }) {
  try {
    await fileSystem.access(filePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await writeStorage({ fileSystem, filePath, storage: INITIAL_STORAGE });
  }
}

async function writeStorage({ fileSystem, filePath, storage }) {
  await fileSystem.mkdir(dirname(filePath), { recursive: true });
  await fileSystem.writeFile(filePath, `${JSON.stringify({ items: storage.items }, null, 2)}\n`, 'utf8');
}

function assertFileSystem(fileSystem) {
  if (!isRecord(fileSystem)) throw new TypeError('fileSystem is required.');
  for (const method of ['access', 'mkdir', 'readFile', 'writeFile']) {
    if (typeof fileSystem[method] !== 'function') throw new TypeError(`fileSystem.${method} must be a function.`);
  }
}

function assertFilePath(filePath) {
  if (typeof filePath !== 'string' || filePath.trim().length === 0) throw new TypeError('filePath must be a non-empty string.');
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function throwInvalidStorage() {
  const error = new Error('Invalid dead-letter queue storage.');
  error.code = INVALID_DEAD_LETTER_QUEUE_STORAGE_CODE;
  throw error;
}
