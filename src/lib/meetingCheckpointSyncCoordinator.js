const DEFAULT_CHECKPOINT_SYNC_DELAY_MS = 5000;
const DEFAULT_CHECKPOINT_RETRY_DELAY_MS = 5000;

function refinementVersion(cue) {
  return Number.isInteger(cue?.refinement?.version) ? cue.refinement.version : 0;
}

function refinementStatusRank(cue) {
  return { pending: 0, queued: 1, running: 2, failed: 3, completed: 4 }[cue?.refinement?.status] ?? 0;
}

function preferCue(incoming, existing) {
  const versionDelta = refinementVersion(incoming) - refinementVersion(existing);
  if (versionDelta !== 0) return versionDelta > 0 ? incoming : existing;
  const statusDelta = refinementStatusRank(incoming) - refinementStatusRank(existing);
  if (statusDelta !== 0) return statusDelta > 0 ? incoming : existing;
  return (incoming?.refinedSource || incoming?.refinedTranslation) && !(existing?.refinedSource || existing?.refinedTranslation)
    ? incoming
    : existing;
}

export function createMeetingCheckpointSyncCoordinator({
  updateCheckpoint,
  getCheckpoint,
  onStatusChange,
  onError,
  delayMs = DEFAULT_CHECKPOINT_SYNC_DELAY_MS,
  retryDelayMs = DEFAULT_CHECKPOINT_RETRY_DELAY_MS,
  setTimeoutFn = globalThis.setTimeout,
  clearTimeoutFn = globalThis.clearTimeout
} = {}) {
  if (typeof updateCheckpoint !== 'function') throw new TypeError('updateCheckpoint is required.');
  if (getCheckpoint !== undefined && typeof getCheckpoint !== 'function') throw new TypeError('getCheckpoint must be a function.');
  if (typeof setTimeoutFn !== 'function') throw new TypeError('setTimeoutFn is required.');
  if (typeof clearTimeoutFn !== 'function') throw new TypeError('clearTimeoutFn is required.');

  const pendingChunks = new Map();
  const pendingCues = new Map();
  let pendingCueCheckpoint = null;
  let context = null;
  let contextGeneration = 0;
  let timer = null;
  let retryTimer = null;
  let queue = Promise.resolve();

  return Object.freeze({
    start(nextContext = {}) {
      contextGeneration += 1;
      context = { ...normalizeContext(nextContext), generation: contextGeneration };
      clearTimer();
      clearRetryTimer();
      onStatusChange?.('ready');
    },

    enqueue(chunks = []) {
      if (!context) return;
      for (const chunk of chunks) {
        if (validChunk(chunk)) pendingChunks.set(chunk.idempotencyKey, chunk);
      }
      if (pendingChunks.size === 0 || timer || retryTimer) return;

      const scheduledGeneration = context.generation;
      timer = setTimeoutFn(() => {
        timer = null;
        void enqueueFlush(scheduledGeneration);
      }, Math.max(0, delayMs));
    },

    enqueueCues(cues = [], checkpoint = null) {
      if (!context) return;
      for (const cue of cues) {
        if (cue?.status !== 'final' || !cue.cueId) continue;
        pendingCues.set(cue.cueId, pendingCues.has(cue.cueId) ? preferCue(cue, pendingCues.get(cue.cueId)) : cue);
      }
      if (checkpoint) pendingCueCheckpoint = { checkpoint, generation: context.generation };
      if ((pendingChunks.size > 0 || pendingCues.size > 0 || pendingCueCheckpoint) && !timer && !retryTimer) {
        const scheduledGeneration = context.generation;
        timer = setTimeoutFn(() => { timer = null; void enqueueFlush(scheduledGeneration); }, Math.max(0, delayMs));
      }
    },

    flush() {
      clearTimer();
      clearRetryTimer();
      return enqueueFlush(context?.generation);
    },

    cancel() {
      clearTimer();
      clearRetryTimer();
      contextGeneration += 1;
      context = null;
      onStatusChange?.('idle');
    }
  });

  function enqueueFlush(expectedGeneration = context?.generation) {
    queue = queue.then(() => flushPending(expectedGeneration));
    return queue;
  }

  async function flushPending(expectedGeneration) {
    if (!context || context.generation !== expectedGeneration) return true;

    const flushContext = context;
    const chunks = sortedChunks(Array.from(pendingChunks.values()).filter((chunk) => (
      chunk.meetingId === flushContext.meetingId && chunk.segmentId === flushContext.segmentId
    )));
    const cues = [...pendingCues.values()]
      .filter((cue) => cue.segmentId === flushContext.segmentId)
      .sort((left, right) => left.sequence - right.sequence);
    const payloadCheckpoint = pendingCueCheckpoint?.generation === flushContext.generation
      ? pendingCueCheckpoint.checkpoint
      : null;
    if (chunks.length === 0 && cues.length === 0 && !payloadCheckpoint) return true;

    onStatusChange?.('syncing');

    try {
      await updateCheckpoint({
        meetingId: flushContext.meetingId,
        segmentId: flushContext.segmentId,
        idempotencyKey: checkpointIdempotencyKey(flushContext.segmentId, chunks),
        durableChunks: chunks,
        finalCues: cues,
        cueCheckpoint: payloadCheckpoint,
        refinedSubtitleCues: payloadCheckpoint?.refinedSubtitleCues,
        refinedSubtitleRevision: payloadCheckpoint?.refinedSubtitleRevision,
        refinedSubtitleInputHash: payloadCheckpoint?.refinedSubtitleInputHash,
        refinedSubtitleStatus: payloadCheckpoint?.refinedSubtitleStatus
      });

      for (const chunk of chunks) {
        const pending = pendingChunks.get(chunk.idempotencyKey);
        if (pending && sameChunk(pending, chunk)) pendingChunks.delete(chunk.idempotencyKey);
      }
      for (const cue of cues) {
        const pending = pendingCues.get(cue.cueId);
        if (pending && JSON.stringify(pending) === JSON.stringify(cue)) pendingCues.delete(cue.cueId);
      }
      if (
        pendingCueCheckpoint?.generation === flushContext.generation &&
        JSON.stringify(pendingCueCheckpoint.checkpoint) === JSON.stringify(payloadCheckpoint)
      ) pendingCueCheckpoint = null;
      retryTimer = null;
      if (context?.generation === flushContext.generation) {
        onStatusChange?.(pendingChunks.size > 0 ? 'ready' : 'synced');
      }
      return true;
    } catch (error) {
      if (context?.generation !== flushContext.generation) return false;

      if (error?.status === 409 && getCheckpoint) {
        try {
          const latest = await getCheckpoint({
            meetingId: flushContext.meetingId,
            segmentId: flushContext.segmentId
          });
          reconcilePendingWithCheckpoint(latest?.checkpoint);
          if (context?.generation !== flushContext.generation) return false;
          onStatusChange?.(pendingChunks.size > 0 || pendingCues.size > 0 || pendingCueCheckpoint ? 'ready' : 'synced');
          if (pendingChunks.size > 0 || pendingCues.size > 0 || pendingCueCheckpoint) {
            scheduleRetry(flushContext.generation);
          }
          return false;
        } catch (reconcileError) {
          onError?.(reconcileError);
        }
      }

      onStatusChange?.('error');
      onError?.(error);
      if (context?.generation === flushContext.generation && isRetryableCheckpointError(error)) scheduleRetry(flushContext.generation);
      return false;
    }
  }

  function clearTimer() {
    if (!timer) return;
    clearTimeoutFn(timer);
    timer = null;
  }

  function scheduleRetry(generation) {
    if (retryTimer || !context || context.generation !== generation) return;
    retryTimer = setTimeoutFn(() => {
      retryTimer = null;
      void enqueueFlush(generation);
    }, Math.max(0, retryDelayMs));
  }

  function clearRetryTimer() {
    if (!retryTimer) return;
    clearTimeoutFn(retryTimer);
    retryTimer = null;
  }

  function reconcilePendingWithCheckpoint(checkpoint) {
    const persistedChunks = Array.isArray(checkpoint?.durableChunks) ? checkpoint.durableChunks : [];
    const persistedByKey = new Map(persistedChunks.map((chunk) => [chunk?.idempotencyKey, chunk]));
    const persistedBySequence = new Map(persistedChunks.map((chunk) => [`${chunk?.stream}:${chunk?.sequence}`, chunk]));

    for (const [key, pending] of pendingChunks) {
      const persisted = persistedByKey.get(key) || persistedBySequence.get(`${pending.stream}:${pending.sequence}`);
      if (persisted && (sameChunk(persisted, pending) || persistedBySequence.get(`${pending.stream}:${pending.sequence}`))) {
        pendingChunks.delete(key);
      }
    }

    const persistedCues = new Map((Array.isArray(checkpoint?.finalCues) ? checkpoint.finalCues : []).map((cue) => [cue?.cueId, cue]));
    for (const [cueId, pending] of pendingCues) {
      const persisted = persistedCues.get(cueId);
      if (!persisted || preferCue(pending, persisted) === persisted) {
        pendingCues.delete(cueId);
      }
    }

    if (pendingCueCheckpoint && checkpoint?.cueCheckpoint) {
      pendingCueCheckpoint = null;
    }
  }
}

function isRetryableCheckpointError(error) {
  const status = Number(error?.status);
  if (status === 404 || status === 409 || status === 413) return false;
  return !Number.isFinite(status) || status === 408 || status === 425 || status === 429 || status >= 500;
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
