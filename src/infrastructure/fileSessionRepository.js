import { dirname } from 'node:path';
import {
  createSessionRecord as createSessionRecordModel,
  createTranscriptItemForSession,
  finalizeSessionRecord as finalizeSessionRecordModel,
  summarizeTranscriptItems,
  updateSessionRecord as updateSessionRecordModel
} from '../lib/sessionRecords.js';

const INITIAL_STORAGE = Object.freeze({
  schemaVersion: 1,
  records: Object.freeze([]),
  transcriptItems: Object.freeze({})
});

export function createFileSessionRepository({ filePath, fileSystem, now, idFactory } = {}) {
  assertFilePath(filePath);
  assertFileSystem(fileSystem);

  let mutationQueue = Promise.resolve();
  let cachedStorage = null;

  return Object.freeze({
    async createSessionRecord(input = {}) {
      return mutate(async (storage) => {
        const record = createSessionRecordModel(input, { now, idFactory });
        if (storage.records.some((stored) => stored.id === record.id)) {
          throw new Error(`Session record already exists: ${record.id}`);
        }

        storage.records.push(clonePlain(record));
        storage.transcriptItems[record.id] = [];
        return clonePlain(record);
      });
    },

    async updateSessionRecord(id, patch = {}) {
      return mutate(async (storage) => {
        const index = requireRecordIndex(storage.records, id);
        const updated = updateSessionRecordModel(storage.records[index], patch, { now });
        storage.records[index] = clonePlain(updated);
        return clonePlain(updated);
      });
    },

    async appendTranscriptItem(sessionId, item = {}) {
      return mutate(async (storage) => {
        const recordIndex = requireRecordIndex(storage.records, sessionId);
        const existingItems = storage.transcriptItems[sessionId] || [];
        const sessionItem = createTranscriptItemForSession(sessionId, item);
        const nextItems = [...existingItems, clonePlain(sessionItem)];
        const updatedRecord = updateSessionRecordModel(
          storage.records[recordIndex],
          { transcriptSummary: summarizeTranscriptItems(nextItems) },
          { now }
        );

        storage.transcriptItems[sessionId] = nextItems;
        storage.records[recordIndex] = clonePlain(updatedRecord);
        return clonePlain(sessionItem);
      });
    },

    async finalizeSessionRecord(id, patch = {}) {
      return mutate(async (storage) => {
        const index = requireRecordIndex(storage.records, id);
        const items = storage.transcriptItems[id] || [];
        const finalized = finalizeSessionRecordModel(
          storage.records[index],
          {
            ...patch,
            transcriptSummary: patch.transcriptSummary ?? summarizeTranscriptItems(items)
          },
          { now }
        );

        storage.records[index] = clonePlain(finalized);
        return clonePlain(finalized);
      });
    },

    async listSessionRecords() {
      const storage = await readCachedStorage();
      return storage.records.map(clonePlain);
    },

    async getSessionRecord(id) {
      const storage = await readCachedStorage();
      const record = storage.records.find((stored) => stored.id === id);
      if (!record) return null;

      return {
        sessionRecord: clonePlain(record),
        transcriptItems: (storage.transcriptItems[id] || []).map(clonePlain)
      };
    },

    async deleteSessionRecord(id) {
      return mutate(async (storage) => {
        const index = storage.records.findIndex((record) => record.id === id);
        const hadItems = Object.hasOwn(storage.transcriptItems, id);
        if (index !== -1) storage.records.splice(index, 1);
        delete storage.transcriptItems[id];
        return index !== -1 || hadItems;
      });
    }
  });

  function mutate(operation) {
    const nextMutation = mutationQueue.then(async () => {
      const storage = await readMutableStorage();
      const result = await operation(storage);
      cachedStorage = await writeStorage({ filePath, fileSystem, storage });
      return result;
    });

    mutationQueue = nextMutation.catch(() => {});
    return nextMutation;
  }

  async function readCachedStorage() {
    if (cachedStorage) {
      return cachedStorage;
    }

    cachedStorage = await readStorage({ filePath, fileSystem });
    return cachedStorage;
  }

  async function readMutableStorage() {
    return clonePlain(await readCachedStorage());
  }
}

async function readStorage({ filePath, fileSystem }) {
  let content;
  try {
    content = await fileSystem.readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return clonePlain(INITIAL_STORAGE);
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    const error = new TypeError('Session repository JSON is invalid.');
    error.code = 'invalid_session_repository_storage';
    throw error;
  }

  return normalizeStorage(parsed);
}

async function writeStorage({ filePath, fileSystem, storage }) {
  const normalized = normalizeStorage(storage);
  const directory = dirname(filePath);
  await fileSystem.mkdir(directory, { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  await fileSystem.writeFile(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  await fileSystem.rename(temporaryPath, filePath);
  return normalized;
}

function normalizeStorage(value) {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.records) || !isRecord(value.transcriptItems)) {
    const error = new TypeError('Session repository storage shape is invalid.');
    error.code = 'invalid_session_repository_storage';
    throw error;
  }

  const records = value.records.map((record, index) => {
    if (!isRecord(record) || typeof record.id !== 'string' || record.id.trim().length === 0) {
      const error = new TypeError(`Session repository record ${index} is invalid.`);
      error.code = 'invalid_session_repository_storage';
      throw error;
    }
    return clonePlain(record);
  });

  const transcriptItems = {};
  for (const [sessionId, items] of Object.entries(value.transcriptItems)) {
    if (!Array.isArray(items)) {
      const error = new TypeError(`Session repository transcriptItems.${sessionId} must be an array.`);
      error.code = 'invalid_session_repository_storage';
      throw error;
    }
    transcriptItems[sessionId] = items.map(clonePlain);
  }

  return { schemaVersion: 1, records, transcriptItems };
}

function requireRecordIndex(records, id) {
  const index = records.findIndex((record) => record.id === id);
  if (index === -1) throw new Error(`Session record not found: ${id}`);
  return index;
}

function assertFilePath(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError('SESSION_RECORDS_FILE must be a non-empty string when provided.');
  }
}

function assertFileSystem(value) {
  for (const method of ['readFile', 'mkdir', 'writeFile', 'rename']) {
    if (!value || typeof value[method] !== 'function') {
      throw new TypeError(`fileSystem.${method} must be a function.`);
    }
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clonePlain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}
