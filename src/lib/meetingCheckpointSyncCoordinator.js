const DEFAULT_CHECKPOINT_SYNC_DELAY_MS = 5000;

export function createMeetingCheckpointSyncCoordinator({
  updateCheckpoint,
  onStatusChange,
  onError,
  delayMs = DEFAULT_CHECKPOINT_SYNC_DELAY_MS,
  setTimeoutFn = globalThis.setTimeout,
  clearTimeoutFn = globalThis.clearTimeout
} = {}) {
  if (typeof updateCheckpoint !== 'function') throw new TypeError('updateCheckpoint is required.');
  if (typeof setTimeoutFn !== 'function') throw new TypeError('setTimeoutFn is required.');
  if (typeof clearTimeoutFn !== 'function') throw new TypeError('clearTimeoutFn is required.');

  const pendingChunks = new Map();
  let context = null;
  let timer = null;
  let queue = Promise.resolve();

  return Object.freeze({
    start(nextContext = {}) {
      context = normalizeContext(nextContext);
      pendingChunks.clear();
      clearTimer();
      onStatusChange?.('ready');
    },

    enqueue(chunks = []) {
      if (!context) return;
      for (const chunk of chunks) {
        if (validChunk(chunk)) pendingChunks.set(chunk.idempotencyKey, chunk);
      }
      if (pendingChunks.size === 0 || timer) return;

      timer = setTimeoutFn(() => {
        timer = null;
        void enqueueFlush();
      }, Math.max(0, delayMs));
    },

    flush() {
      clearTimer();
      return enqueueFlush();
    },

    cancel() {
      clearTimer();
      context = null;
      pendingChunks.clear();
      onStatusChange?.('idle');
    }
  });

  function enqueueFlush() {
    queue = queue.then(flushPending);
    return queue;
  }

  async function flushPending() {
    if (!context || pendingChunks.size === 0) return true;

    const chunks = sortedChunks(Array.from(pendingChunks.values()));
    onStatusChange?.('syncing');

    try {
      await updateCheckpoint({
        meetingId: context.meetingId,
        segmentId: context.segmentId,
        idempotencyKey: checkpointIdempotencyKey(context.segmentId, chunks),
        durableChunks: chunks
      });

      for (const chunk of chunks) {
        const pending = pendingChunks.get(chunk.idempotencyKey);
        if (pending && sameChunk(pending, chunk)) pendingChunks.delete(chunk.idempotencyKey);
      }
      onStatusChange?.(pendingChunks.size > 0 ? 'ready' : 'synced');
      return true;
    } catch (error) {
      onStatusChange?.('error');
      onError?.(error);
      return false;
    }
  }

  function clearTimer() {
    if (!timer) return;
    clearTimeoutFn(timer);
    timer = null;
  }
}

export function checkpointChunksForTranscriptItems({ meetingId, segmentId, transcriptItems = [] } = {}) {
  if (!meetingId || !segmentId) return [];

  return transcriptItems
    .filter((item) => item?.status === 'final' && (item.stream === 'source' || item.stream === 'translation'))
    .map((item) => ({
      idempotencyKey: `checkpoint:${segmentId}:${item.id}`,
      meetingId,
      segmentId,
      stream: item.stream,
      sequence: item.sequence,
      text: item.text,
      timestamp: item.finalizedAt ?? item.startedAt
    }))
    .filter(validChunk);
}

function normalizeContext(contextInput = {}) {
  const meetingId = contextInput.meetingId;
  const segmentId = contextInput.segmentId;
  if (typeof meetingId !== 'string' || meetingId.trim().length === 0) throw new TypeError('meetingId must be a non-empty string.');
  if (typeof segmentId !== 'string' || segmentId.trim().length === 0) throw new TypeError('segmentId must be a non-empty string.');
  return { meetingId, segmentId };
}

function checkpointIdempotencyKey(segmentId, chunks) {
  const lastChunk = chunks.at(-1);
  return `checkpoint:${segmentId}:${lastChunk?.stream || 'empty'}:${lastChunk?.sequence ?? 0}`;
}

function sortedChunks(chunks) {
  return [...chunks].sort((left, right) => (
    streamOrder(left.stream) - streamOrder(right.stream) ||
    left.sequence - right.sequence ||
    left.idempotencyKey.localeCompare(right.idempotencyKey)
  ));
}

function streamOrder(stream) {
  return stream === 'source' ? 0 : 1;
}

function validChunk(chunk) {
  return chunk &&
    typeof chunk.idempotencyKey === 'string' &&
    typeof chunk.meetingId === 'string' &&
    typeof chunk.segmentId === 'string' &&
    (chunk.stream === 'source' || chunk.stream === 'translation') &&
    Number.isInteger(chunk.sequence) &&
    chunk.sequence >= 0 &&
    typeof chunk.text === 'string' &&
    (typeof chunk.timestamp === 'string' || typeof chunk.timestamp === 'number');
}

function sameChunk(left, right) {
  return left.idempotencyKey === right.idempotencyKey &&
    left.meetingId === right.meetingId &&
    left.segmentId === right.segmentId &&
    left.stream === right.stream &&
    left.sequence === right.sequence &&
    left.text === right.text &&
    left.timestamp === right.timestamp;
}
