import {
  reconcileLocalMeetingChunks,
  sealLocalChunk
} from './localMeetingStorage.js';

export const LOCAL_RECORDER_STATES = Object.freeze([
  'idle',
  'capturing',
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

  return Object.freeze({
    start(nextMeetingId) {
      if (state === 'capturing' && meetingId === nextMeetingId) return snapshot();
      if (state !== 'idle' && meetingId !== nextMeetingId) throw conflict('local_recorder_active');
      if (!nextMeetingId) throw invalid('meetingId is required.');
      meetingId = nextMeetingId;
      finalSequence = null;
      stopError = null;
      state = 'capturing';
      return snapshot();
    },

    async appendChunk(input, bytes) {
      assertCapturing();
      const record = await manifestStore.reserve({ ...input, meetingId: input?.meetingId || meetingId });
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

    async stop({ finalSequence: requestedFinalSequence } = {}) {
      if (state === 'stopped_local') return snapshot();
      if (state === 'stop_incomplete') return snapshot();
      if (state !== 'capturing') return snapshot();
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
        return snapshot();
      } catch (error) {
        stopError = error;
        state = 'stop_incomplete';
        throw error;
      }
    },

    snapshot
  });

  function assertCapturing() {
    if (state !== 'capturing') throw conflict('local_recorder_not_capturing');
  }

  function snapshot() {
    return Object.freeze({ state, meetingId, finalSequence, stopError });
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
