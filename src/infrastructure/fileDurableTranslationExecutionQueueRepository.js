import { dirname } from 'node:path';
import {
  compareDurableTranslationExecutionQueueItemIdentity,
  createTranslationExecutionQueueItemConflictError,
  createDurableTranslationExecutionQueueItemNotClaimableError,
  createTranslationExecutionQueueItemNotFoundError,
  createDurableTranslationExecutionQueueItem,
  createDurableTranslationExecutionQueueRepository,
  DURABLE_TRANSLATION_EXECUTION_QUEUE_ITEM_IDENTITY,
  normalizeDurableTranslationExecutionQueueItem
} from '../application/translation/durableTranslationExecutionQueueRepository.js';

export const INVALID_TRANSLATION_EXECUTION_QUEUE_STORAGE_CODE = 'invalid_translation_execution_queue_storage';

const INITIAL_STORAGE = Object.freeze({ items: [] });

export function createFileDurableTranslationExecutionQueueRepository({ fileSystem, filePath } = {}) {
  assertFileSystem(fileSystem);
  assertFilePath(filePath);

  return createDurableTranslationExecutionQueueRepository({
    async enqueue(item) {
      const storage = await readStorage({ fileSystem, filePath });

      const existingItem = storage.items.find((candidate) => candidate.executionId === item.executionId);
      if (existingItem === undefined) {
        storage.items.push(createDurableTranslationExecutionQueueItem(item));
        await writeStorage({ fileSystem, filePath, storage });
        return undefined;
      }

      if (compareDurableTranslationExecutionQueueItemIdentity(existingItem, item)
        === DURABLE_TRANSLATION_EXECUTION_QUEUE_ITEM_IDENTITY.CONFLICT) {
        throw createTranslationExecutionQueueItemConflictError();
      }

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

    async list() {
      const storage = await readStorage({ fileSystem, filePath });
      return storage.items;
    },

    async size() {
      const storage = await readStorage({ fileSystem, filePath });
      return storage.items.length;
    },

    async clear() {
      await writeStorage({ fileSystem, filePath, storage: INITIAL_STORAGE });
      return undefined;
    },

    async updateStatus(executionId, status) {
      const storage = await readStorage({ fileSystem, filePath });
      const itemIndex = storage.items.findIndex((item) => item.executionId === executionId);

      if (itemIndex === -1) {
        throw new Error(`Durable translation execution queue item ${executionId} was not found`);
      }

      storage.items[itemIndex] = createUpdatedItem(storage.items[itemIndex], status);
      await writeStorage({ fileSystem, filePath, storage });
      return undefined;
    },

    async acknowledge(executionId) {
      const storage = await readStorage({ fileSystem, filePath });
      const itemIndex = storage.items.findIndex((item) => item.executionId === executionId);

      if (itemIndex === -1) {
        throw createTranslationExecutionQueueItemNotFoundError(executionId);
      }

      const item = storage.items.splice(itemIndex, 1)[0];
      await writeStorage({ fileSystem, filePath, storage });
      return item;
    },

    async contains(executionId) {
      const storage = await readExistingStorage({ fileSystem, filePath });
      return storage !== null && storage.items.some((item) => item.executionId === executionId);
    },

    async claim(executionId, lease) {
      const storage = await readStorage({ fileSystem, filePath });
      const itemIndex = storage.items.findIndex((item) => item.executionId === executionId);
      if (itemIndex === -1) throwNotFound(executionId);
      if (storage.items[itemIndex].status !== 'queued') {
        throw createDurableTranslationExecutionQueueItemNotClaimableError();
      }

      storage.items[itemIndex] = createDurableTranslationExecutionQueueItem({
        ...storage.items[itemIndex],
        status: 'processing',
        ...lease
      });
      await writeStorage({ fileSystem, filePath, storage });
    },

    async requeueExpiredProcessing(executionId, now) {
      const storage = await readStorage({ fileSystem, filePath });
      const itemIndex = storage.items.findIndex((item) => item.executionId === executionId);
      const item = storage.items[itemIndex];
      if (!isExpiredProcessingItem(item, now)) return null;

      const requeuedItem = createRequeuedItem(item);
      storage.items[itemIndex] = requeuedItem;
      await writeStorage({ fileSystem, filePath, storage });
      return requeuedItem;
    }
  });
}

async function readStorage({ fileSystem, filePath }) {
  await ensureStorageFile({ fileSystem, filePath });

  return readExistingStorage({ fileSystem, filePath });
}

async function readExistingStorage({ fileSystem, filePath }) {
  let parsed;
  try {
    parsed = JSON.parse(await fileSystem.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }

    throwInvalidStorage();
  }

  assertStorage(parsed);

  return {
    items: parsed.items.map((item) => normalizeDurableTranslationExecutionQueueItem(item))
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
        enqueuedAt: item.enqueuedAt,
        status: item.status,
        ...(item.status === 'processing' && item.leaseId !== undefined
          ? {
              leaseId: item.leaseId,
              claimedAt: item.claimedAt,
              leaseExpiresAt: item.leaseExpiresAt
            }
          : {})
      }))
    },
    null,
    2
  )}\n`;
}

function createUpdatedItem(item, status) {
  const nextItem = { ...item, status };
  if (status === 'completed' || status === 'failed') {
    delete nextItem.leaseId;
    delete nextItem.claimedAt;
    delete nextItem.leaseExpiresAt;
  }
  return createDurableTranslationExecutionQueueItem(nextItem);
}

function isExpiredProcessingItem(item, now) {
  return item !== undefined
    && item.status === 'processing'
    && item.leaseId !== undefined
    && item.claimedAt !== undefined
    && item.leaseExpiresAt !== undefined
    && item.leaseExpiresAt <= now;
}

function createRequeuedItem(item) {
  const requeuedItem = { ...item, status: 'queued' };
  delete requeuedItem.leaseId;
  delete requeuedItem.claimedAt;
  delete requeuedItem.leaseExpiresAt;
  return createDurableTranslationExecutionQueueItem(requeuedItem);
}

function throwNotFound(executionId) { throw new Error(`Durable translation execution queue item ${executionId} was not found`); }

function assertStorage(value) {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    throwInvalidStorage();
  }

  try {
    for (const item of value.items) {
      normalizeDurableTranslationExecutionQueueItem(item);
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
