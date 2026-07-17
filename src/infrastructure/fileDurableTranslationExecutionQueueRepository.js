import { dirname } from 'node:path';
import {
  createDurableTranslationExecutionQueueItem,
  createDurableTranslationExecutionQueueRepository
} from '../application/translation/durableTranslationExecutionQueueRepository.js';

export const INVALID_TRANSLATION_EXECUTION_QUEUE_STORAGE_CODE = 'invalid_translation_execution_queue_storage';

const INITIAL_STORAGE = Object.freeze({ items: [] });

export function createFileDurableTranslationExecutionQueueRepository({ fileSystem, filePath } = {}) {
  assertFileSystem(fileSystem);
  assertFilePath(filePath);

  return createDurableTranslationExecutionQueueRepository({
    async enqueue(item) {
      const storage = await readStorage({ fileSystem, filePath });
      storage.items.push(createDurableTranslationExecutionQueueItem(item));
      await writeStorage({ fileSystem, filePath, storage });
      return undefined;
    },

    async dequeue() {
      const storage = await readStorage({ fileSystem, filePath });
      const item = storage.items.shift() ?? null;
      await writeStorage({ fileSystem, filePath, storage });
      return item;
    },

    async peek() {
      const storage = await readStorage({ fileSystem, filePath });
      return storage.items[0] ?? null;
    },

    async size() {
      const storage = await readStorage({ fileSystem, filePath });
      return storage.items.length;
    },

    async clear() {
      await writeStorage({ fileSystem, filePath, storage: INITIAL_STORAGE });
      return undefined;
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

  assertStorage(parsed);

  return {
    items: parsed.items.map((item) => createDurableTranslationExecutionQueueItem(item))
  };
}

async function ensureStorageFile({ fileSystem, filePath }) {
  try {
    await fileSystem.access(filePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }

    await fileSystem.mkdir(dirname(filePath), { recursive: true });
    await writeStorage({ fileSystem, filePath, storage: INITIAL_STORAGE });
  }
}

async function writeStorage({ fileSystem, filePath, storage }) {
  await fileSystem.mkdir(dirname(filePath), { recursive: true });
  await fileSystem.writeFile(filePath, serializeStorage(storage), 'utf8');
}

function serializeStorage(storage) {
  return `${JSON.stringify(
    {
      items: storage.items.map((item) => ({
        executionId: item.executionId,
        requestId: item.requestId,
        enqueuedAt: item.enqueuedAt
      }))
    },
    null,
    2
  )}\n`;
}

function assertStorage(value) {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    throwInvalidStorage();
  }

  try {
    for (const item of value.items) {
      createDurableTranslationExecutionQueueItem(item);
    }
  } catch {
    throwInvalidStorage();
  }
}

function assertFileSystem(fileSystem) {
  if (!isRecord(fileSystem)) {
    throw new TypeError('fileSystem is required.');
  }

  for (const methodName of ['access', 'mkdir', 'readFile', 'writeFile']) {
    if (typeof fileSystem[methodName] !== 'function') {
      throw new TypeError(`fileSystem.${methodName} must be a function.`);
    }
  }
}

function assertFilePath(filePath) {
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    throw new TypeError('filePath must be a non-empty string.');
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function throwInvalidStorage() {
  const error = new Error('Invalid translation execution queue storage.');
  error.code = INVALID_TRANSLATION_EXECUTION_QUEUE_STORAGE_CODE;
  throw error;
}
