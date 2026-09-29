export const LOCAL_MEETING_SCHEMA_VERSION = 2;

export const LOCAL_CHUNK_STATES = Object.freeze([
  'writing',
  'sealed',
  'missing',
  'corrupt',
  'orphan',
  'deleting'
]);

const STATE_SET = new Set(LOCAL_CHUNK_STATES);

export function buildLocalChunkPath({ meetingId, segmentId, sequence, chunkId, extension = 'webm' } = {}) {
  const meeting = safePathPart(meetingId, 'meetingId');
  const segment = safePathPart(segmentId, 'segmentId');
  const normalizedSequence = normalizePositiveInteger(sequence, 'sequence');
  const id = safePathPart(chunkId, 'chunkId');
  const suffix = String(extension || 'webm').replace(/[^a-z0-9]+/giu, '').toLowerCase() || 'webm';
  return `meetings/${meeting}/segments/${segment}/chunks/${String(normalizedSequence).padStart(8, '0')}-${id}.${suffix}`;
}

export function reserveLocalChunk({ meetingId, recordingId = meetingId, segmentId, chunkId, sequence, startedAt, endedAt = null, byteSize = null, checksum = null, mimeType = 'audio/webm' } = {}) {
  const record = {
    schemaVersion: LOCAL_MEETING_SCHEMA_VERSION,
    meetingId: safePathPart(meetingId, 'meetingId'),
    recordingId: safePathPart(recordingId, 'recordingId'),
    segmentId: safePathPart(segmentId, 'segmentId'),
    chunkId: safePathPart(chunkId, 'chunkId'),
    sequence: normalizePositiveInteger(sequence, 'sequence'),
    startedAt: normalizeTimestamp(startedAt, 'startedAt'),
    endedAt: endedAt === null ? null : normalizeTimestamp(endedAt, 'endedAt'),
    byteSize: normalizeOptionalNonNegativeInteger(byteSize, 'byteSize'),
    checksum: normalizeOptionalString(checksum, 'checksum'),
    mimeType: normalizeMimeType(mimeType),
    path: buildLocalChunkPath({ meetingId, segmentId, sequence, chunkId, extension: extensionForMimeType(mimeType) }),
    state: 'writing',
    createdAt: Date.now(),
    sealedAt: null,
    deleteRequestedAt: null
  };
  return Object.freeze(record);
}

export function sealLocalChunk(record, { byteSize, checksum, endedAt = record?.endedAt } = {}) {
  assertChunkRecord(record);
  if (record.state === 'sealed') {
    const normalizedByteSize = normalizeNonNegativeInteger(byteSize, 'byteSize');
    const normalizedChecksum = normalizeRequiredString(checksum, 'checksum');
    if (record.byteSize !== normalizedByteSize || record.checksum !== normalizedChecksum) {
      throw conflict('local_chunk_seal_conflict');
    }
    return record;
  }
  if (record.state !== 'writing') throw conflict('local_chunk_not_sealable');
  const sealed = {
    ...record,
    byteSize: normalizeNonNegativeInteger(byteSize, 'byteSize'),
    checksum: normalizeRequiredString(checksum, 'checksum'),
    endedAt: normalizeTimestamp(endedAt, 'endedAt'),
    state: 'sealed',
    sealedAt: Date.now()
  };
  if (sealed.endedAt < sealed.startedAt) throw invalid('endedAt must be after startedAt.');
  return Object.freeze(sealed);
}

export function markLocalChunk(record, state) {
  assertChunkRecord(record);
  if (!STATE_SET.has(state)) throw invalid(`Unknown local chunk state: ${state}.`);
  if (record.state === 'deleting' && state !== 'deleting') return record;
  const allowed = {
    writing: new Set(['writing', 'sealed', 'missing', 'corrupt', 'deleting']),
    sealed: new Set(['sealed', 'missing', 'corrupt', 'deleting']),
    missing: new Set(['missing', 'deleting']),
    corrupt: new Set(['corrupt', 'deleting']),
    orphan: new Set(['orphan', 'deleting']),
    deleting: new Set(['deleting'])
  };
  if (!allowed[record.state]?.has(state)) throw conflict('local_chunk_state_conflict');
  return Object.freeze({
    ...record,
    state,
    deleteRequestedAt: state === 'deleting' ? (record.deleteRequestedAt || Date.now()) : record.deleteRequestedAt
  });
}

export function reconcileLocalMeetingChunks({ manifest = [], files = [] } = {}) {
  const records = Array.isArray(manifest) ? manifest : [];
  const fileMap = new Map((Array.isArray(files) ? files : []).map((file) => [file.path, file]));
  const referencedPaths = new Set();
  const reconciled = records.map((record) => {
    assertChunkRecord(record);
    referencedPaths.add(record.path);
    const file = fileMap.get(record.path);
    if (!file) return record.state === 'writing' || record.state === 'sealed' ? markLocalChunk(record, 'missing') : record;
    if (record.state === 'writing' && matchesExpectedFile(record, file)) {
      return sealLocalChunk(record, {
        byteSize: file.byteSize,
        checksum: file.checksum,
        endedAt: record.endedAt || file.endedAt
      });
    }
    if (record.state === 'sealed' && !matchesExpectedFile(record, file)) return markLocalChunk(record, 'corrupt');
    return record;
  });

  const orphans = (Array.isArray(files) ? files : [])
    .filter((file) => !referencedPaths.has(file.path))
    .map((file) => ({
      path: String(file.path || ''),
      byteSize: normalizeOptionalNonNegativeInteger(file.byteSize, 'byteSize'),
      checksum: normalizeOptionalString(file.checksum, 'checksum'),
      state: 'orphan'
    }));

  return Object.freeze({ chunks: Object.freeze(reconciled), orphans: Object.freeze(orphans) });
}

export function createInMemoryLocalMeetingManifestStore(initial = []) {
  const records = new Map();
  const recordings = new Map();
  for (const rawRecord of initial) {
    const record = projectLocalChunk(rawRecord);
    assertChunkRecord(record);
    records.set(record.chunkId, record);
  }

  return Object.freeze({
    getRecording(meetingId) {
      const value = recordings.get(meetingId);
      return value ? Object.freeze({ ...value }) : null;
    },
    saveRecording(input) {
      const record = projectLocalRecording(input);
      recordings.set(record.meetingId, record);
      return Object.freeze({ ...record });
    },
    async reserve(input) {
      const record = reserveLocalChunk(input);
      const existing = records.get(record.chunkId);
      if (existing) {
        if (!sameChunkIdentity(existing, record)) {
          throw conflict('local_chunk_identity_conflict');
        }
        return Object.freeze({ ...existing });
      }
      if ([...records.values()].some((value) => value.meetingId === record.meetingId && value.sequence === record.sequence)) {
        throw conflict('local_chunk_sequence_conflict');
      }
      records.set(record.chunkId, { ...record });
      return Object.freeze({ ...record });
    },
    async seal(chunkId, input) {
      const current = getRecord(records, chunkId);
      const next = sealLocalChunk(current, input);
      records.set(chunkId, { ...next });
      return Object.freeze({ ...next });
    },
    async mark(chunkId, state) {
      const next = markLocalChunk(getRecord(records, chunkId), state);
      records.set(chunkId, { ...next });
      return Object.freeze({ ...next });
    },
    async get(chunkId) {
      const value = records.get(chunkId);
      return value ? projectLocalChunk(value) : null;
    },
    async list(meetingId) {
      return Object.freeze([...records.values()]
        .filter((record) => meetingId === undefined || record.meetingId === meetingId)
        .sort((left, right) => left.sequence - right.sequence)
        .map(projectLocalChunk));
    }
  });
}

export function createIndexedDbLocalMeetingManifestStore({
  indexedDBImpl = globalThis.indexedDB,
  dbName = 'live-translate-local-meetings-v1'
} = {}) {
  if (!indexedDBImpl || typeof indexedDBImpl.open !== 'function') throw new Error('IndexedDB is unavailable.');
  let databasePromise;

  return Object.freeze({
    async reserve(input) {
      const record = reserveLocalChunk(input);
      const database = await openDatabase();
      return runTransaction(database, 'readwrite', async (store) => {
        const existing = await request(store.get(record.chunkId));
        if (existing) {
          const projected = projectLocalChunk(existing);
          if (!sameChunkIdentity(projected, record)) throw conflict('local_chunk_identity_conflict');
          if (!sameProjection(existing, projected)) await request(store.put(projected));
          return projected;
        }
        const records = await request(store.getAll());
        if (records.some((value) => value.meetingId === record.meetingId && value.sequence === record.sequence)) {
          throw conflict('local_chunk_sequence_conflict');
        }
        await request(store.add(record));
        return record;
      });
    },
    async seal(chunkId, input) {
      const database = await openDatabase();
      return runTransaction(database, 'readwrite', async (store) => {
        const current = await request(store.get(chunkId));
        if (!current) throw invalid(`Unknown local chunk: ${chunkId}.`);
        const next = sealLocalChunk(projectLocalChunk(current), input);
        await request(store.put(next));
        return next;
      });
    },
    async mark(chunkId, state) {
      const database = await openDatabase();
      return runTransaction(database, 'readwrite', async (store) => {
        const current = await request(store.get(chunkId));
        if (!current) throw invalid(`Unknown local chunk: ${chunkId}.`);
        const next = markLocalChunk(projectLocalChunk(current), state);
        await request(store.put(next));
        return next;
      });
    },
    async get(chunkId) {
      const database = await openDatabase();
      return runTransaction(database, 'readwrite', async (store) => {
        const record = await request(store.get(chunkId));
        if (!record) return null;
        const projected = projectLocalChunk(record);
        if (!sameProjection(record, projected)) await request(store.put(projected));
        return projected;
      });
    },
    async list(meetingId) {
      const database = await openDatabase();
      return runTransaction(database, 'readwrite', async (store) => {
        const records = await request(store.getAll());
        const projected = records.map(projectLocalChunk);
        for (let index = 0; index < records.length; index += 1) {
          if (!sameProjection(records[index], projected[index])) await request(store.put(projected[index]));
        }
        return projected
          .filter((record) => meetingId === undefined || record.meetingId === meetingId)
          .sort((left, right) => left.sequence - right.sequence);
      });
    }
  });

  function openDatabase() {
    if (!databasePromise) {
      databasePromise = new Promise((resolve, reject) => {
        const requestHandle = indexedDBImpl.open(dbName, LOCAL_MEETING_SCHEMA_VERSION);
        requestHandle.onupgradeneeded = () => {
          const database = requestHandle.result;
          if (!database.objectStoreNames.contains('chunks')) {
            const store = database.createObjectStore('chunks', { keyPath: 'chunkId' });
            store.createIndex('meeting-sequence', ['meetingId', 'sequence'], { unique: true });
          }
        };
        requestHandle.onsuccess = () => resolve(requestHandle.result);
        requestHandle.onerror = () => reject(requestHandle.error || new Error('IndexedDB open failed.'));
        requestHandle.onblocked = () => reject(new Error('IndexedDB upgrade is blocked.'));
      });
    }
    return databasePromise;
  }
}

export function createOpfsChunkStore({ rootDirectory = null } = {}) {
  return Object.freeze({
    async write(path, bytes) {
      const file = await fileHandle(rootDirectory, path, true);
      const writable = await file.createWritable();
      try {
        await writable.write(bytes);
        await writable.close();
      } catch (error) {
        try { await writable.abort?.(); } catch { /* best effort */ }
        throw error;
      }
      return path;
    },
    async read(path) {
      const file = await fileHandle(rootDirectory, path, false);
      return file.getFile();
    },
    async remove(path) {
      const { directory, name } = await parentDirectory(rootDirectory, path, false);
      await directory.removeEntry(name);
    }
  });
}

function projectLocalChunk(value) {
  const record = value || {};
  return Object.freeze({
    schemaVersion: record.schemaVersion,
    meetingId: record.meetingId,
    recordingId: record.recordingId || record.meetingId,
    segmentId: record.segmentId,
    chunkId: record.chunkId,
    sequence: record.sequence,
    startedAt: record.startedAt,
    endedAt: record.endedAt ?? null,
    byteSize: record.byteSize ?? null,
    checksum: record.checksum ?? null,
    mimeType: record.mimeType,
    path: record.path,
    state: record.state,
    createdAt: record.createdAt,
    sealedAt: record.sealedAt ?? null,
    deleteRequestedAt: record.deleteRequestedAt ?? null
  });
}

function projectLocalRecording(value = {}) {
  return Object.freeze({
    meetingId: value.meetingId,
    recordingId: value.recordingId,
    segmentId: value.segmentId,
    captureEpoch: value.captureEpoch,
    providerEpoch: value.providerEpoch,
    state: value.state,
    finalSequence: value.finalSequence ?? null,
    terminal: value.terminal === true,
    finalized: value.finalized === true
  });
}

function sameProjection(raw, projected) {
  const rawKeys = Object.keys(raw).sort();
  const projectedKeys = Object.keys(projected).sort();
  return rawKeys.length === projectedKeys.length && rawKeys.every((key, index) => key === projectedKeys[index] && raw[key] === projected[key]);
}

function sameChunkIdentity(left, right) {
  return left.meetingId === right.meetingId &&
    (left.recordingId || left.meetingId) === (right.recordingId || right.meetingId) &&
    left.segmentId === right.segmentId &&
    left.sequence === right.sequence &&
    left.checksum === right.checksum;
}

function matchesExpectedFile(record, file) {
  return Number(file.byteSize) === Number(record.byteSize) &&
    String(file.checksum || '') === String(record.checksum || '');
}

function getRecord(records, chunkId) {
  const value = records.get(chunkId);
  if (!value) throw invalid(`Unknown local chunk: ${chunkId}.`);
  return value;
}

function assertChunkRecord(record) {
  if (!record || typeof record !== 'object' || !STATE_SET.has(record.state)) throw invalid('Invalid local chunk record.');
}

function extensionForMimeType(mimeType) {
  return String(mimeType || '').toLowerCase().includes('ogg') ? 'ogg' : 'webm';
}

function normalizeMimeType(value) {
  const mimeType = normalizeRequiredString(value, 'mimeType');
  if (!/^audio\/[a-z0-9.+-]+(?:;[^\s]+)?$/iu.test(mimeType)) throw invalid('mimeType must be an audio MIME type.');
  return mimeType;
}

function normalizeTimestamp(value, field) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp < 0) throw invalid(`${field} must be a non-negative timestamp.`);
  return timestamp;
}

function normalizePositiveInteger(value, field) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw invalid(`${field} must be a positive integer.`);
  return number;
}

function normalizeNonNegativeInteger(value, field) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw invalid(`${field} must be a non-negative integer.`);
  return number;
}

function normalizeOptionalNonNegativeInteger(value, field) {
  return value === null || value === undefined ? null : normalizeNonNegativeInteger(value, field);
}

function normalizeRequiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw invalid(`${field} is required.`);
  return value.trim();
}

function normalizeOptionalString(value, field) {
  if (value === null || value === undefined || value === '') return null;
  return normalizeRequiredString(value, field);
}

function safePathPart(value, field) {
  const part = normalizeRequiredString(value, field);
  if (!/^[a-z0-9][a-z0-9._:-]*$/iu.test(part)) throw invalid(`${field} contains unsafe path characters.`);
  return part;
}

function invalid(message) {
  const error = new TypeError(message);
  error.code = 'invalid_request';
  return error;
}

function conflict(code) {
  const error = new Error(code);
  error.code = code;
  error.status = 409;
  return error;
}

async function fileHandle(rootDirectory, path, create) {
  const { directory, name } = await parentDirectory(rootDirectory, path, create);
  return directory.getFileHandle(name, { create });
}

async function parentDirectory(rootDirectory, path, create) {
  const resolvedRoot = rootDirectory || await globalThis.navigator?.storage?.getDirectory?.();
  if (!resolvedRoot || typeof resolvedRoot.getDirectoryHandle !== 'function') throw new Error('OPFS is unavailable.');
  const parts = String(path || '').split('/').filter(Boolean);
  const name = parts.pop();
  if (!name || parts.some((part) => part === '.' || part === '..')) throw invalid('Invalid OPFS path.');
  let directory = resolvedRoot;
  for (const part of parts) directory = await directory.getDirectoryHandle(part, { create });
  return { directory, name };
}

function request(requestHandle) {
  return new Promise((resolve, reject) => {
    requestHandle.onsuccess = () => resolve(requestHandle.result);
    requestHandle.onerror = () => reject(requestHandle.error || new Error('IndexedDB request failed.'));
  });
}

async function runTransaction(database, mode, operation) {
  const transaction = database.transaction('chunks', mode);
  const completion = new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed.'));
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted.'));
  });
  try {
    const result = await operation(transaction.objectStore('chunks'));
    await completion;
    return result;
  } catch (error) {
    await completion.catch(() => {});
    throw error;
  }
}
