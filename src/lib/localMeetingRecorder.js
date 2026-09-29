import {
  reconcileLocalMeetingChunks,
  sealLocalChunk
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
  if (!chunkStore || typeof chunkStore.write !== 'function') throw new TypeError('chunkStore must implement write.');

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
  let resolveStopBarrier = null;
  let rejectStopBarrier = null;

  return Object.freeze({
    start(nextMeetingId, { operationId, recordingId: requestedRecordingId, segmentId: requestedSegmentId } = {}) {
      if (operationId && operations.has(operationId)) return operations.get(operationId);
      if (state === 'capturing' && meetingId === nextMeetingId) return snapshot();
      if (state === 'stopped_local') throw conflict('local_recorder_finalized');
      if (state !== 'idle' && meetingId !== nextMeetingId) throw conflict('local_recorder_active');
      if (!nextMeetingId) throw invalid('meetingId is required.');
      const durable = manifestStore.getRecording?.(nextMeetingId);
      if (durable?.finalized || durable?.terminal) throw conflict('local_recorder_finalized');
      meetingId = nextMeetingId;
      recordingId = requestedRecordingId || `recording:${meetingId}`;
      segmentId = requestedSegmentId || `segment:${recordingId}:1`;
      segmentNumber = 1;
      captureEpoch += 1;
      providerEpoch = 0;
      finalSequence = null;
      stopError = null;
      state = 'capturing';
      return remember(operationId);
    },

    pause({ operationId } = {}) {
      if (operationId && operations.has(operationId)) return operations.get(operationId);
      if (state === 'capturing') { state = 'paused'; captureEpoch += 1; }
      return remember(operationId);
    },

    resume({ operationId } = {}) {
      if (operationId && operations.has(operationId)) return operations.get(operationId);
      if (state === 'paused') { segmentNumber += 1; segmentId = `segment:${recordingId}:${segmentNumber}`; captureEpoch += 1; state = 'capturing'; }
      return remember(operationId);
    },

    recover({ operationId } = {}) {
      return this.resume({ operationId });
    },

    providerReconnect({ operationId } = {}) {
      if (operationId && operations.has(operationId)) return operations.get(operationId);
      if (state === 'capturing' || state === 'paused') providerEpoch += 1;
      return remember(operationId);
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
      if (operationId && operations.has(operationId)) return operations.get(operationId);
      if (state === 'stopped_local') return snapshot();
      if (stopBarrier) return stopBarrier;
      stopBarrier = new Promise((resolve, reject) => { resolveStopBarrier = resolve; rejectStopBarrier = reject; });
      stopBarrier.catch(() => {});
      await appendQueue;
      if (state !== 'capturing' && state !== 'stop_incomplete') return snapshot();
      state = 'stopping';
      try {
        const chunks = await manifestStore.list(meetingId);
        const sealed = chunks.filter((chunk) => chunk.state === 'sealed');
        const highest = sealed.reduce((value, chunk) => Math.max(value, chunk.sequence), 0);
        const requested = requestedFinalSequence === undefined ? highest : Number(requestedFinalSequence);
        if (!Number.isSafeInteger(requested) || requested < 0) throw invalid('finalSequence must be a non-negative integer.');
        const missing = [];
        for (let sequence = 1; sequence <= requested; sequence += 1) {
          const chunk = sealed.find((value) => value.sequence === sequence);
          if (!chunk) missing.push(sequence);
        }
        if (missing.length > 0) {
          const error = conflict('local_recorder_final_sequence_incomplete');
          error.missingSequences = missing;
          throw error;
        }
        finalSequence = requested;
        state = 'stopped_local';
        const result = remember(operationId);
        manifestStore.saveRecording?.({ ...result, terminal: true, finalized: true });
        resolveStopBarrier(result);
        return result;
      } catch (error) {
        stopError = error;
        state = 'stop_incomplete';
        rejectStopBarrier(error);
        stopBarrier = null;
        throw error;
      }
    },

    finalize(options) { return this.stop(options); },
    snapshot
  });

  function assertCapturing() {
    if (state !== 'capturing') throw conflict('local_recorder_not_capturing');
  }

  async function appendChunkLocked(input, bytes) {
    assertCapturing();
    const record = await manifestStore.reserve({ ...input, meetingId: input?.meetingId || meetingId, recordingId: input?.recordingId || recordingId, segmentId: input?.segmentId || segmentId });
    if (record.state === 'sealed') return record;
    try {
      await chunkStore.write(record.path, bytes);
    } catch (error) {
      stopError = error;
      throw error;
    }
    return manifestStore.seal(record.chunkId, {
      byteSize: input?.byteSize,
      checksum: input?.checksum,
      endedAt: input?.endedAt || now()
    });
  }

  function snapshot() {
    return Object.freeze({ state, meetingId, recordingId, segmentId, captureEpoch, providerEpoch, finalSequence, stopError });
  }

  function remember(operationId) {
    const result = snapshot();
    if (operationId) operations.set(operationId, result);
    return result;
  }
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
