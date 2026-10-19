import { mergeCheckpoint } from '../application/meetingCheckpointService.js';
import { checkCheckpointOperation, checkpointConflict, recordCheckpointOperation } from './checkpointOperation.js';

export const LOCAL_MEETING_SCHEMA_VERSION = 5;

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
  const operations = new Map();
  const cues = new Map();
  const checkpoints = new Map();
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
    getOperation(meetingId, operationId) {
      const value = operations.get(operationKey(meetingId, operationId));
      return value ? projectLocalOperation(value) : null;
    },
    saveContinueOperation(input) {
      const operation = projectContinueOperation(input);
      const existing = operations.get(operation.key);
      if (existing && !sameContinueIdentity(existing, operation)) throw conflict('local_continue_operation_conflict');
      operations.set(operation.key, operation);
      return operation;
    },
    getPendingContinueOperation(meetingId) {
      const values = [...operations.values()]
        .filter((value) => value.meetingId === meetingId
          && value.type === 'legacy_continue'
          && value.state !== 'complete')
        .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
      return values[0] ? projectContinueOperation(values[0]) : null;
    },
    commitRecordingOperation({ recording: recordingInput, operation: operationInput }) {
      const recording = projectLocalRecording(recordingInput);
      const operation = projectLocalOperation(operationInput);
      if (recording.meetingId !== operation.meetingId) throw conflict('local_recorder_operation_conflict');
      const key = operationKey(operation.meetingId, operation.operationId);
      const existing = operations.get(key);
      if (existing && !sameProjection(existing, operation)) throw conflict('local_recorder_operation_conflict');
      recordings.set(recording.meetingId, recording);
      operations.set(key, operation);
      return operation.result;
    },
    async saveCue(input) {
      const cue = projectLocalCue(input);
      const existing = cues.get(cue.key);
      if (existing && !sameCueIdentity(existing, cue)) throw conflict('local_cue_identity_conflict');
      cues.set(cue.key, cue);
      return cue;
    },
    async listCues(meetingId, { segmentId } = {}) {
      return Object.freeze([...cues.values()]
        .filter((record) => record.meetingId === meetingId && (!segmentId || record.segmentId === segmentId))
        .sort(compareLocalCues)
        .map((record) => projectLocalCue(record)));
    },
    async saveCheckpoint(input) {
      const checkpoint = projectLocalCheckpoint(input);
      const existing = checkpoints.get(checkpoint.key);
      const saved = mergeLocalCheckpoint(existing, checkpoint);
      checkpoints.set(checkpoint.key, saved);
      return saved;
    },
    async getCheckpoint(meetingId, segmentId) {
      const value = checkpoints.get(localCheckpointKey(meetingId, segmentId));
      return value ? projectLocalCheckpoint(value) : null;
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
    async getRetention(meetingId) {
      const database = await openDatabase();
      return runNamedTransaction(database, 'retentions', 'readonly', async (transaction) =>
        (await request(transaction.objectStore('retentions').get(meetingId))) || null);
    },
    async listRetentions() {
      const database = await openDatabase();
      return runNamedTransaction(database, 'retentions', 'readonly', async (transaction) =>
        request(transaction.objectStore('retentions').getAll()));
    },
    async saveRetention(input) {
      const database = await openDatabase();
      return runNamedTransaction(database, 'retentions', 'readwrite', async (transaction) => {
        const store = transaction.objectStore('retentions');
        const previous = await request(store.get(input.meetingId));
        const previousExpiry = Date.parse(previous?.expiresAt || '');
        const nextExpiry = Date.parse(input.expiresAt || '');
        const record = {
          ...previous,
          ...input,
          recordingId: previous?.recordingId || input.recordingId || null,
          expiresAt: Number.isFinite(previousExpiry) && Number.isFinite(nextExpiry)
            ? new Date(Math.min(previousExpiry, nextExpiry)).toISOString()
            : previous?.expiresAt || input.expiresAt || null,
          deleted: Boolean(previous?.deleted || input.deleted),
          physicalCleared: Boolean(previous?.physicalCleared)
        };
        await request(store.put(record));
        return record;
      });
    },
    async listLocalMeetingIds() {
      const database = await openDatabase();
      return runNamedTransaction(database, ['recordings', 'chunks', 'cues', 'checkpoints'], 'readonly', async (transaction) => {
        const records = await Promise.all(['recordings', 'chunks', 'cues', 'checkpoints']
          .map((name) => request(transaction.objectStore(name).getAll())));
        return [...new Set(records.flat().map((row) => row.meetingId).filter(Boolean))];
      });
    },
    async clearMeetingContent(meetingId) {
      const database = await openDatabase();
      return runNamedTransaction(database,
        ['recordings', 'chunks', 'operations', 'cues', 'checkpoints', 'retentions'], 'readwrite',
        async (transaction) => {
          for (const name of ['recordings', 'chunks', 'operations', 'cues', 'checkpoints']) {
            const store = transaction.objectStore(name);
            const records = await request(store.getAll());
            for (const row of records) {
              if (row.meetingId === meetingId) await request(store.delete(name === 'recordings' ? meetingId : row.key || row.chunkId));
            }
          }
          const retentions = transaction.objectStore('retentions');
          const record = await request(retentions.get(meetingId));
          if (record) await request(retentions.put({ ...record, physicalCleared: true, cleanupError: null }));
        });
    },
    async getRecording(meetingId) {
      const database = await openDatabase();
      return runNamedTransaction(database, 'recordings', 'readwrite', async (transaction) => {
        const store = transaction.objectStore('recordings');
        const raw = await request(store.get(meetingId));
        if (!raw) return null;
        const projected = projectLocalRecording(raw);
        if (!sameProjection(raw, projected)) await request(store.put(projected));
        return projected;
      });
    },
    async saveRecording(input) {
      const recording = projectLocalRecording(input);
      const database = await openDatabase();
      return runNamedTransaction(database, 'recordings', 'readwrite', async (transaction) => {
        await request(transaction.objectStore('recordings').put(recording));
        return recording;
      });
    },
    async getOperation(meetingId, operationId) {
      const database = await openDatabase();
      return runNamedTransaction(database, 'operations', 'readwrite', async (transaction) => {
        const store = transaction.objectStore('operations');
        const raw = await request(store.get(operationKey(meetingId, operationId)));
        if (!raw) return null;
        const projected = projectLocalOperation(raw);
        if (!sameProjection(raw, projected)) await request(store.put(projected));
        return projected;
      });
    },
    async saveContinueOperation(input) {
      const operation = projectContinueOperation(input);
      const database = await openDatabase();
      return runNamedTransaction(database, 'operations', 'readwrite', async (transaction) => {
        const store = transaction.objectStore('operations');
        const existing = await request(store.get(operation.key));
        if (existing && !sameContinueIdentity(existing, operation)) throw conflict('local_continue_operation_conflict');
        await request(store.put(operation));
        return operation;
      });
    },
    async getPendingContinueOperation(meetingId) {
      normalizeRequiredString(meetingId, 'meetingId');
      const database = await openDatabase();
      return runNamedTransaction(database, 'operations', 'readonly', async (transaction) => {
        const values = await request(transaction.objectStore('operations').getAll());
        const matches = values
          .filter((value) => value.meetingId === meetingId
            && value.type === 'legacy_continue'
            && value.state !== 'complete')
          .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
        return matches[0] ? projectContinueOperation(matches[0]) : null;
      });
    },
    async commitRecordingOperation({ recording: recordingInput, operation: operationInput }) {
      const recording = projectLocalRecording(recordingInput);
      const operation = projectLocalOperation(operationInput);
      if (recording.meetingId !== operation.meetingId) throw conflict('local_recorder_operation_conflict');
      const database = await openDatabase();
      return runNamedTransaction(database, ['recordings', 'operations'], 'readwrite', async (transaction) => {
        const operationStore = transaction.objectStore('operations');
        const existing = await request(operationStore.get(operation.key));
        if (existing && !sameProjection(projectLocalOperation(existing), operation)) {
          throw conflict('local_recorder_operation_conflict');
        }
        await request(transaction.objectStore('recordings').put(recording));
        if (!existing) await request(operationStore.add(operation));
        return operation.result;
      });
    },
    async saveCue(input) {
      const cue = projectLocalCue(input);
      const database = await openDatabase();
      return runNamedTransaction(database, 'cues', 'readwrite', async (transaction) => {
        const store = transaction.objectStore('cues');
        const existing = await request(store.get(cue.key));
        if (existing && !sameCueIdentity(projectLocalCue(existing), cue)) throw conflict('local_cue_identity_conflict');
        await request(store.put(cue));
        return cue;
      });
    },
    async listCues(meetingId, { segmentId } = {}) {
      normalizeRequiredString(meetingId, 'meetingId');
      const database = await openDatabase();
      return runNamedTransaction(database, 'cues', 'readwrite', async (transaction) => {
        const store = transaction.objectStore('cues');
        const records = await request(store.getAll());
        const projected = records.map(projectLocalCue);
        for (let index = 0; index < records.length; index += 1) {
          if (!sameProjection(records[index], projected[index])) await request(store.put(projected[index]));
        }
        return projected
          .filter((record) => record.meetingId === meetingId && (!segmentId || record.segmentId === segmentId))
          .sort(compareLocalCues);
      });
    },
    async saveCheckpoint(input) {
      const checkpoint = projectLocalCheckpoint(input);
      const database = await openDatabase();
      return runNamedTransaction(database, 'checkpoints', 'readwrite', async (transaction) => {
        const store = transaction.objectStore('checkpoints');
        const existing = await request(store.get(checkpoint.key));
        const projected = existing ? projectLocalCheckpoint(existing) : null;
        const saved = mergeLocalCheckpoint(projected, checkpoint);
        if (saved !== projected) await request(store.put(saved));
        return saved;
      });
    },
    async getCheckpoint(meetingId, segmentId) {
      const key = localCheckpointKey(meetingId, segmentId);
      const database = await openDatabase();
      return runNamedTransaction(database, 'checkpoints', 'readwrite', async (transaction) => {
        const store = transaction.objectStore('checkpoints');
        const raw = await request(store.get(key));
        if (!raw) return null;
        const projected = projectLocalCheckpoint(raw);
        if (!sameProjection(raw, projected)) await request(store.put(projected));
        return projected;
      });
    },
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
          if (!database.objectStoreNames.contains('recordings')) {
            database.createObjectStore('recordings', { keyPath: 'meetingId' });
          }
          if (!database.objectStoreNames.contains('operations')) {
            database.createObjectStore('operations', { keyPath: 'key' });
          }
          if (!database.objectStoreNames.contains('cues')) {
            const store = database.createObjectStore('cues', { keyPath: 'key' });
            store.createIndex('meeting-segment-sequence', ['meetingId', 'segmentId', 'sequence'], { unique: true });
          }
          if (!database.objectStoreNames.contains('checkpoints')) {
            database.createObjectStore('checkpoints', { keyPath: 'key' });
          }
          if (!database.objectStoreNames.contains('retentions')) {
            database.createObjectStore('retentions', { keyPath: 'meetingId' });
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
      const { directory, name } = await parentDirectory(rootDirectory, path, true);
      try {
        await directory.getFileHandle(name, { create: false });
        throw conflict('local_chunk_file_exists');
      } catch (error) {
        if (error?.code === 'local_chunk_file_exists') throw error;
        if (error?.name !== 'NotFoundError') throw error;
      }
      const file = await directory.getFileHandle(name, { create: true });
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
    },
    async removeMeeting(meetingId) {
      const name = safePathPart(meetingId, 'meetingId');
      const root = rootDirectory || await globalThis.navigator?.storage?.getDirectory?.();
      if (!root) throw new Error('OPFS is unavailable.');
      let meetings;
      try {
        meetings = await root.getDirectoryHandle('meetings');
      } catch (error) {
        if (error?.name === 'NotFoundError') return;
        throw error;
      }
      try {
        await meetings.removeEntry(name, { recursive: true });
      } catch (error) {
        if (error?.name !== 'NotFoundError') throw error;
      }
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
    schemaVersion: LOCAL_MEETING_SCHEMA_VERSION,
    meetingId: value.meetingId,
    recordingId: value.recordingId,
    segmentId: value.segmentId,
    segmentNumber: normalizeSegmentNumber(value.segmentNumber, value.segmentId),
    captureEpoch: value.captureEpoch,
    providerEpoch: value.providerEpoch,
    state: value.state,
    finalSequence: value.finalSequence ?? null,
    terminal: value.terminal === true,
    finalized: value.finalized === true
  });
}

function projectContinueOperation(value = {}) {
  const meetingId = normalizeRequiredString(value.meetingId, 'meetingId');
  const operationId = normalizeRequiredString(value.operationId, 'operationId');
  const sourceSegmentId = normalizeRequiredString(value.sourceSegmentId, 'sourceSegmentId');
  const nextLiveSessionId = normalizeRequiredString(value.nextLiveSessionId, 'nextLiveSessionId');
  const payloadHash = normalizeRequiredString(value.payloadHash, 'payloadHash');
  const timestamp = normalizeRequiredString(value.updatedAt || value.createdAt || new Date().toISOString(), 'updatedAt');
  return Object.freeze({
    schemaVersion: 1,
    key: operationKey(meetingId, operationId),
    type: 'legacy_continue',
    operationId,
    meetingId,
    sourceSegmentId,
    nextLiveSessionId,
    expectedSessionId: value.expectedSessionId ? String(value.expectedSessionId) : null,
    payloadHash,
    checkpoint: value.checkpoint && typeof value.checkpoint === 'object' ? structuredClone(value.checkpoint) : {},
    attempt: Number.isSafeInteger(value.attempt) && value.attempt >= 0 ? value.attempt : 0,
    state: String(value.state || 'pending'),
    committedSuccessor: value.committedSuccessor && typeof value.committedSuccessor === 'object'
      ? structuredClone(value.committedSuccessor)
      : null,
    createdAt: String(value.createdAt || timestamp),
    updatedAt: timestamp
  });
}

function sameContinueIdentity(left, right) {
  return left.operationId === right.operationId
    && left.meetingId === right.meetingId
    && left.sourceSegmentId === right.sourceSegmentId
    && left.nextLiveSessionId === right.nextLiveSessionId
    && left.expectedSessionId === right.expectedSessionId
    && left.payloadHash === right.payloadHash;
}

function projectLocalOperation(value = {}) {
  const meetingId = normalizeRequiredString(value.meetingId, 'meetingId');
  const operationId = normalizeRequiredString(value.operationId, 'operationId');
  return Object.freeze({
    schemaVersion: LOCAL_MEETING_SCHEMA_VERSION,
    key: operationKey(meetingId, operationId),
    meetingId,
    operationId,
    type: normalizeRequiredString(value.type, 'type'),
    result: projectLocalOperationResult(value.result)
  });
}

function projectLocalOperationResult(value = {}) {
  return Object.freeze({
    state: value.state,
    meetingId: value.meetingId,
    recordingId: value.recordingId,
    segmentId: value.segmentId,
    captureEpoch: value.captureEpoch,
    providerEpoch: value.providerEpoch,
    finalSequence: value.finalSequence ?? null,
    stopError: null
  });
}

function projectLocalCue(value = {}) {
  const meetingId = normalizeRequiredString(value.meetingId, 'meetingId');
  const segmentId = normalizeRequiredString(value.segmentId, 'segmentId');
  const sessionId = normalizeRequiredString(value.sessionId, 'sessionId');
  const rawCue = value.cue && typeof value.cue === 'object' ? value.cue : value;
  const cueId = normalizeRequiredString(value.cueId || rawCue.cueId, 'cueId');
  const sequence = normalizePositiveInteger(value.sequence ?? rawCue.sequence, 'sequence');
  return Object.freeze({
    schemaVersion: LOCAL_MEETING_SCHEMA_VERSION,
    key: localCueKey(meetingId, segmentId, cueId),
    meetingId,
    sessionId,
    segmentId,
    cueId,
    sequence,
    cue: sanitizeLocalValue(rawCue),
    producedAt: normalizeOptionalTimestamp(value.producedAt ?? rawCue.finalizedAt, 'producedAt'),
    updatedAt: normalizeOptionalTimestamp(value.updatedAt, 'updatedAt') ?? Date.now()
  });
}

function mergeLocalCheckpoint(existing, incoming) {
  const payload = incoming.checkpoint;
  if (typeof payload.idempotencyKey !== 'string' || !payload.idempotencyKey) {
    if (existing) throw checkpointConflict('legacy checkpoint update has no operation key');
    return incoming;
  }
  const operation = checkCheckpointOperation(existing?.checkpoint, payload);
  if (operation.duplicate) return existing;
  const delta = {
    ...payload,
    durableChunks: Array.isArray(payload.durableChunks) ? payload.durableChunks : [],
    finalCues: Array.isArray(payload.finalCues) ? payload.finalCues : []
  };
  const merged = mergeCheckpoint({
    existing: existing?.checkpoint,
    incoming: delta,
    meetingId: incoming.meetingId,
    segmentId: incoming.segmentId,
    updatedAt: incoming.updatedAt
  });
  return projectLocalCheckpoint({
    ...incoming,
    checkpoint: recordCheckpointOperation(existing?.checkpoint, payload, merged, operation.canonical)
  });
}

function projectLocalCheckpoint(value = {}) {
  const meetingId = normalizeRequiredString(value.meetingId, 'meetingId');
  const segmentId = normalizeRequiredString(value.segmentId, 'segmentId');
  const rawCheckpoint = value.checkpoint && typeof value.checkpoint === 'object'
    ? value.checkpoint
    : Object.fromEntries(Object.entries(value).filter(([key]) => !['key', 'schemaVersion', 'meetingId', 'segmentId', 'updatedAt'].includes(key)));
  return Object.freeze({
    schemaVersion: LOCAL_MEETING_SCHEMA_VERSION,
    key: localCheckpointKey(meetingId, segmentId),
    meetingId,
    segmentId,
    checkpoint: sanitizeLocalValue(rawCheckpoint),
    updatedAt: normalizeOptionalTimestamp(value.updatedAt, 'updatedAt') ?? Date.now()
  });
}

function sanitizeLocalValue(value, seen = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map((item) => sanitizeLocalValue(item, seen));
  if (!value || typeof value !== 'object') return null;
  if (seen.has(value)) throw invalid('Local persistence value must not be cyclic.');
  seen.add(value);
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (isCredentialField(key)) continue;
    result[key] = sanitizeLocalValue(item, seen);
  }
  seen.delete(value);
  return Object.freeze(result);
}

function isCredentialField(key) {
  return /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|ephemeral[_-]?token|authorization|credential|jwt|secret)/iu.test(key);
}

function localCueKey(meetingId, segmentId, cueId) {
  return `${normalizeRequiredString(meetingId, 'meetingId')}\u0000${normalizeRequiredString(segmentId, 'segmentId')}\u0000${normalizeRequiredString(cueId, 'cueId')}`;
}

function localCheckpointKey(meetingId, segmentId) {
  return `${normalizeRequiredString(meetingId, 'meetingId')}\u0000${normalizeRequiredString(segmentId, 'segmentId')}`;
}

function sameCueIdentity(left, right) {
  return left.meetingId === right.meetingId && left.sessionId === right.sessionId &&
    left.segmentId === right.segmentId && left.cueId === right.cueId && left.sequence === right.sequence;
}

function compareLocalCues(left, right) {
  return left.sequence - right.sequence || left.cueId.localeCompare(right.cueId);
}

function operationKey(meetingId, operationId) {
  return `${normalizeRequiredString(meetingId, 'meetingId')}\u0000${normalizeRequiredString(operationId, 'operationId')}`;
}

function normalizeSegmentNumber(value, segmentId) {
  if (Number.isSafeInteger(Number(value)) && Number(value) > 0) return Number(value);
  const match = String(segmentId || '').match(/:(\d+)$/u);
  return match ? Number(match[1]) : 1;
}

function sameProjection(raw, projected) {
  return JSON.stringify(raw) === JSON.stringify(projected);
}

function sameChunkIdentity(left, right) {
  return left.meetingId === right.meetingId &&
    (left.recordingId || left.meetingId) === (right.recordingId || right.meetingId) &&
    left.segmentId === right.segmentId &&
    left.chunkId === right.chunkId &&
    left.sequence === right.sequence &&
    left.startedAt === right.startedAt &&
    left.endedAt === right.endedAt &&
    left.byteSize === right.byteSize &&
    left.checksum === right.checksum &&
    left.mimeType === right.mimeType &&
    left.path === right.path;
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

function normalizeOptionalTimestamp(value, field) {
  return value === null || value === undefined ? null : normalizeTimestamp(value, field);
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

async function runNamedTransaction(database, storeNames, mode, operation) {
  const transaction = database.transaction(storeNames, mode);
  const completion = new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed.'));
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted.'));
  });
  try {
    const result = await operation(transaction);
    await completion;
    return result;
  } catch (error) {
    try { transaction.abort(); } catch { /* already completed */ }
    await completion.catch(() => {});
    throw error;
  }
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
