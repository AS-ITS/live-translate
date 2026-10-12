import {
  reconcileLocalMeetingChunks
} from './localMeetingStorage.js';

export const LOCAL_RECORDER_STATES = Object.freeze([
  'idle',
  'capturing',
  'paused',
  'stopping',
  'stopped_local',
  'stop_incomplete'
]);

export function createLocalMeetingRecorder({ manifestStore, chunkStore, now = () => Date.now() } = {}) {
  if (!manifestStore || typeof manifestStore.reserve !== 'function' || typeof manifestStore.seal !== 'function' || typeof manifestStore.mark !== 'function' || typeof manifestStore.list !== 'function') {
    throw new TypeError('manifestStore must implement reserve, seal, mark, and list.');
  }
  if (typeof manifestStore.getRecording !== 'function' || typeof manifestStore.saveRecording !== 'function' || typeof manifestStore.getOperation !== 'function' || typeof manifestStore.commitRecordingOperation !== 'function') {
    throw new TypeError('manifestStore must implement durable recording and operation persistence.');
  }
  if (!chunkStore || typeof chunkStore.write !== 'function' || typeof chunkStore.read !== 'function') {
    throw new TypeError('chunkStore must implement write and read.');
  }

  let state = 'idle';
  let meetingId = null;
  let finalSequence = null;
  let stopError = null;
  let appendQueue = Promise.resolve();
  let recordingId = null;
  let segmentId = null;
  let segmentNumber = 0;
  let captureEpoch = 0;
  let providerEpoch = 0;
  const operations = new Map();
  let stopBarrier = null;

  return Object.freeze({
    async restore(nextMeetingId) {
      if (!nextMeetingId) throw invalid('meetingId is required.');
      if (meetingId && meetingId !== nextMeetingId && state !== 'idle') throw conflict('local_recorder_active');
      const durable = await manifestStore.getRecording(nextMeetingId);
      meetingId = nextMeetingId;
      if (!durable) return snapshot();
      recordingId = durable.recordingId;
      segmentId = durable.segmentId;
      segmentNumber = durable.segmentNumber;
      captureEpoch = durable.captureEpoch;
      providerEpoch = durable.providerEpoch;
      finalSequence = durable.finalSequence;
      state = durable.state;
      stopError = null;
      return snapshot();
    },

    async start(nextMeetingId, { operationId, recordingId: requestedRecordingId, segmentId: requestedSegmentId } = {}) {
      if (!nextMeetingId) throw invalid('meetingId is required.');
      if (meetingId !== nextMeetingId) await this.restore(nextMeetingId);
      const replayed = await replay(operationId, 'start');
      if (replayed) return replayed;
      if (state === 'stopped_local') throw conflict('local_recorder_finalized');
      if (state !== 'idle') {
        if (meetingId !== nextMeetingId) throw conflict('local_recorder_active');
        return persist(operationId, 'start');
      }
      meetingId = nextMeetingId;
      recordingId = requestedRecordingId || globalThis.crypto?.randomUUID?.() || `recording:${meetingId}:${now()}`;
      segmentId = requestedSegmentId || `segment:${recordingId}:1`;
      segmentNumber = 1;
      captureEpoch += 1;
      providerEpoch = 0;
      finalSequence = null;
      stopError = null;
      state = 'capturing';
      return persist(operationId, 'start');
    },

    async pause({ operationId } = {}) {
      const replayed = await replay(operationId, 'pause');
      if (replayed) return replayed;
      if (state === 'capturing') {
        state = 'paused';
        captureEpoch += 1;
      }
      return persist(operationId, 'pause');
    },

    async resume({ operationId } = {}) {
      const replayed = await replay(operationId, 'resume');
      if (replayed) return replayed;
      continueRecording();
      return persist(operationId, 'resume');
    },

    async recover({ operationId } = {}) {
      const replayed = await replay(operationId, 'recover');
      if (replayed) return replayed;
      continueRecording();
      return persist(operationId, 'recover');
    },

    async providerReconnect({ operationId } = {}) {
      return advanceProviderEpoch(operationId, 'provider_reconnect');
    },

    async providerRollover({ operationId } = {}) {
      return advanceProviderEpoch(operationId, 'provider_rollover');
    },

    async rolloverLocalSegment({ operationId, nextSegmentId } = {}) {
      const replayed = await replay(operationId, 'local_segment_rollover');
      if (replayed) return replayed;
      assertActiveRecording();
      const normalizedSegmentId = requiredIdentity(nextSegmentId, 'nextSegmentId');
      if (segmentId !== normalizedSegmentId) {
        segmentId = normalizedSegmentId;
        segmentNumber += 1;
        providerEpoch += 1;
      }
      return persist(operationId, 'local_segment_rollover');
    },

    appendChunk(input, bytes) {
      const task = appendQueue.then(() => appendChunkLocked(input, bytes));
      appendQueue = task.catch(() => {});
      return task;
    },

    async reconcile(files) {
      const current = await manifestStore.list(meetingId);
      const result = reconcileLocalMeetingChunks({ manifest: current, files });
      for (const next of result.chunks) {
        const previous = current.find((record) => record.chunkId === next.chunkId);
        if (!previous || previous.state === next.state) continue;
        if (next.state === 'sealed') {
          await manifestStore.seal(next.chunkId, {
            byteSize: next.byteSize,
            checksum: next.checksum,
            endedAt: next.endedAt
          });
        } else {
          await manifestStore.mark(next.chunkId, next.state);
        }
      }
      return result;
    },

    async stop({ finalSequence: requestedFinalSequence, operationId } = {}) {
      const replayed = await replay(operationId, 'finalize');
      if (replayed) return replayed;
      if (state === 'stopped_local') return persist(operationId, 'finalize');
      if (stopBarrier) return stopBarrier;

      let resolveBarrier;
      let rejectBarrier;
      stopBarrier = new Promise((resolve, reject) => {
        resolveBarrier = resolve;
        rejectBarrier = reject;
      });
      stopBarrier.catch(() => {});

      try {
        await appendQueue;
        if (state !== 'capturing' && state !== 'paused' && state !== 'stop_incomplete') {
          const result = snapshot();
          resolveBarrier(result);
          return result;
        }
        state = 'stopping';
        const chunks = await manifestStore.list(meetingId);
        const sealed = chunks.filter((chunk) => chunk.state === 'sealed');
        const highest = sealed.reduce((value, chunk) => Math.max(value, chunk.sequence), 0);
        const requested = requestedFinalSequence === undefined ? highest : Number(requestedFinalSequence);
        if (!Number.isSafeInteger(requested) || requested < 0) throw invalid('finalSequence must be a non-negative integer.');
        const missing = [];
        for (let sequence = 1; sequence <= requested; sequence += 1) {
          if (!sealed.some((chunk) => chunk.sequence === sequence)) missing.push(sequence);
        }
        if (missing.length > 0) {
          const error = conflict('local_recorder_final_sequence_incomplete');
          error.missingSequences = missing;
          throw error;
        }
        finalSequence = requested;
        state = 'stopped_local';
        stopError = null;
        const result = await persist(operationId, 'finalize');
        resolveBarrier(result);
        return result;
      } catch (error) {
        stopError = error;
        state = 'stop_incomplete';
        await manifestStore.saveRecording(recordingSnapshot());
        rejectBarrier(error);
        throw error;
      } finally {
        stopBarrier = null;
      }
    },

    finalize(options) {
      return this.stop(options);
    },

    snapshot
  });

  function assertCapturing() {
    if (state !== 'capturing') throw conflict('local_recorder_not_capturing');
  }

  function assertActiveRecording() {
    if (state !== 'capturing' && state !== 'paused') {
      throw conflict('local_recorder_not_active');
    }
  }

  function continueRecording() {
    if (state !== 'paused' && state !== 'stop_incomplete') return;
    segmentNumber += 1;
    segmentId = `segment:${recordingId}:${segmentNumber}`;
    captureEpoch += 1;
    state = 'capturing';
    stopError = null;
  }

  async function advanceProviderEpoch(operationId, type) {
    const replayed = await replay(operationId, type);
    if (replayed) return replayed;
    if (state === 'capturing' || state === 'paused') providerEpoch += 1;
    return persist(operationId, type);
  }

  async function appendChunkLocked(input, bytes) {
    assertCapturing();
    const record = await manifestStore.reserve({
      ...input,
      meetingId: input?.meetingId || meetingId,
      recordingId: input?.recordingId || recordingId,
      segmentId: input?.segmentId || segmentId
    });
    if (record.state === 'sealed') {
      await assertStoredChunkMatches(record, bytes);
      return record;
    }
    try {
      await chunkStore.write(record.path, bytes);
    } catch (error) {
      if (error?.code === 'local_chunk_file_exists') {
        await assertStoredChunkMatches(record, bytes);
        return manifestStore.seal(record.chunkId, {
          byteSize: record.byteSize,
          checksum: record.checksum,
          endedAt: record.endedAt || now()
        });
      }
      stopError = error;
      throw error;
    }
    return manifestStore.seal(record.chunkId, {
      byteSize: input?.byteSize,
      checksum: input?.checksum,
      endedAt: input?.endedAt || now()
    });
  }

  async function assertStoredChunkMatches(record, bytes) {
    let stored;
    try {
      stored = await chunkStore.read(record.path);
    } catch (error) {
      const mismatch = conflict('local_chunk_content_conflict');
      mismatch.cause = error;
      throw mismatch;
    }
    const [actualBytes, expectedBytes] = await Promise.all([
      toUint8Array(stored),
      toUint8Array(bytes)
    ]);
    if (record.byteSize !== null && record.byteSize !== expectedBytes.byteLength) {
      throw conflict('local_chunk_content_conflict');
    }
    if (actualBytes.byteLength !== expectedBytes.byteLength) {
      throw conflict('local_chunk_content_conflict');
    }
    for (let index = 0; index < actualBytes.byteLength; index += 1) {
      if (actualBytes[index] !== expectedBytes[index]) throw conflict('local_chunk_content_conflict');
    }
  }

  function snapshot() {
    return Object.freeze({
      state,
      meetingId,
      recordingId,
      segmentId,
      captureEpoch,
      providerEpoch,
      finalSequence,
      stopError
    });
  }

  function recordingSnapshot() {
    return {
      ...snapshot(),
      segmentNumber,
      terminal: state === 'stopped_local',
      finalized: state === 'stopped_local'
    };
  }

  async function replay(operationId, type) {
    if (!operationId) return null;
    const cached = operations.get(operationId);
    if (cached) {
      assertOperationType(cached, type);
      return cached.result;
    }
    if (!meetingId) return null;
    const durable = await manifestStore.getOperation(meetingId, operationId);
    if (!durable) return null;
    assertOperationType(durable, type);
    operations.set(operationId, durable);
    return durable.result;
  }

  async function persist(operationId, type) {
    const result = snapshot();
    const recording = recordingSnapshot();
    if (!operationId) {
      await manifestStore.saveRecording(recording);
      return result;
    }
    const operation = { meetingId, operationId, type, result };
    await manifestStore.commitRecordingOperation({ recording, operation });
    operations.set(operationId, operation);
    return result;
  }
}

async function toUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value && typeof value.arrayBuffer === 'function') {
    return new Uint8Array(await value.arrayBuffer());
  }
  throw conflict('local_chunk_content_conflict');
}

function assertOperationType(operation, type) {
  if (operation.type !== type) throw conflict('local_recorder_operation_conflict');
}

function requiredIdentity(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalid(`${name} must be a non-empty string.`);
  }
  return value;
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
