import { dirname } from 'node:path';
import {
  compareDurableTranslationExecutionQueueItemIdentity,
  createTranslationExecutionQueueItemConflictError,
  createDurableTranslationExecutionQueueItem,
  createDurableTranslationExecutionQueueRepository,
  DURABLE_TRANSLATION_EXECUTION_QUEUE_ITEM_IDENTITY,
  DURABLE_TRANSLATION_EXECUTION_QUEUE_ITEM_STATUSES
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

      storage.items[itemIndex] = createDurableTranslationExecutionQueueItem({
        ...storage.items[itemIndex],
        status
      });
      await writeStorage({ fileSystem, filePath, storage });
      return undefined;
    },

    async acknowledge(executionId) {
      const storage = await readStorage({ fileSystem, filePath });
      const itemIndex = storage.items.findIndex((item) => item.executionId === executionId);

      if (itemIndex === -1) {
        throw new Error(`Durable translation execution queue item ${executionId} was not found`);
      }

      storage.items.splice(itemIndex, 1);
      await writeStorage({ fileSystem, filePath, storage });
      return undefined;
    },

    async contains(executionId) {
      const storage = await readExistingStorage({ fileSystem, filePath });
      return storage !== null && storage.items.some((item) => item.executionId === executionId);
    },

    async claim(executionId, leasedUntil) {
      const storage = await readStorage({ fileSystem, filePath });
      updateLease(storage.items, executionId, leasedUntil);
      await writeStorage({ fileSystem, filePath, storage });
    },

    async releaseExpired(now) {
      const storage = await readStorage({ fileSystem, filePath });
      const released = releaseExpiredLeases(storage.items, now);
      if (released > 0) await writeStorage({ fileSystem, filePath, storage });
      return released;
    },

    async isLeaseExpired(executionId, now) {
      const storage = await readStorage({ fileSystem, filePath });
      const item = storage.items.find((candidate) => candidate.executionId === executionId);
      if (item === undefined) throwNotFound(executionId);
      return item.leasedUntil !== null && item.leasedUntil <= now;
    },

    async renewLease(executionId, leasedUntil) {
      const storage = await readStorage({ fileSystem, filePath });
      updateLease(storage.items, executionId, leasedUntil);
      await writeStorage({ fileSystem, filePath, storage });
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
        enqueuedAt: item.enqueuedAt,
        status: item.status,
        leasedUntil: item.leasedUntil
      }))
    },
    null,
    2
  )}\n`;
}

function updateLease(items, executionId, leasedUntil) {
  const itemIndex = items.findIndex((item) => item.executionId === executionId);
  if (itemIndex === -1) throwNotFound(executionId);
  items[itemIndex] = createDurableTranslationExecutionQueueItem({ ...items[itemIndex], leasedUntil });
}

function releaseExpiredLeases(items, now) {
  let released = 0;
  for (let index = 0; index < items.length; index += 1) {
    if (isRecoverableStatus(items[index].status)
      && items[index].leasedUntil !== null && items[index].leasedUntil <= now) {
      items[index] = createDurableTranslationExecutionQueueItem({ ...items[index], leasedUntil: null });
      released += 1;
    }
  }
  return released;
}

function isRecoverableStatus(status) {
  return status === DURABLE_TRANSLATION_EXECUTION_QUEUE_ITEM_STATUSES.QUEUED
    || status === DURABLE_TRANSLATION_EXECUTION_QUEUE_ITEM_STATUSES.PROCESSING;
}

function throwNotFound(executionId) { throw new Error(`Durable translation execution queue item ${executionId} was not found`); }

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
