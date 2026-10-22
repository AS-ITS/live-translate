import { normalizeCueCheckpoint, validateFinalCue } from '../domain/subtitleCue/index.js';
import { checkpointOperationKey, checkpointConflict } from './checkpointOperation.js';

const DEFAULT_CHECKPOINT_SYNC_DELAY_MS = 5000;
const DEFAULT_CHECKPOINT_RETRY_DELAY_MS = 5000;
const MAX_CONFLICT_RETRIES = 3;

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
  const pendingCueVariants = new Map();
  const pendingCueCheckpoints = new Map();
  let context = null;
  let contextGeneration = 0;
  let ownershipError = false;
  let timer = null;
  const retryTimers = new Map();
  const conflictRetries = new Map();
  let queue = Promise.resolve();

  return Object.freeze({
    start(nextContext = {}) {
      contextGeneration += 1;
      context = { ...normalizeContext(nextContext), generation: contextGeneration };
      ownershipError = false;
      clearTimer();
      onStatusChange?.('ready');
    },

    enqueue(chunks = []) {
      if (!context) return;
      for (const chunk of chunks) {
        if (validChunk(chunk)) pendingChunks.set(chunkKey(chunk), { ...chunk });
      }
      if (pendingChunks.size === 0 || timer || retryTimers.has(scopeKey(context))) return;

      const scheduledContext = { ...context };
      timer = setTimeoutFn(() => {
        timer = null;
        void enqueueFlush(scheduledContext);
      }, Math.max(0, delayMs));
    },

    enqueueCues(cues = [], checkpoint = null) {
      if (!context) return;
      const finalCues = cues.filter((cue) => cue?.status === 'final' && cue.cueId);
      const rejectedCues = finalCues.filter((cue) => cue.segmentId !== context.segmentId);
      const acceptedCues = finalCues.filter((cue) => cue.segmentId === context.segmentId);
      if (rejectedCues.length > 0) {
        const error = new Error('Cue Segment does not match the active Checkpoint.');
        error.code = rejectedCues.some((cue) => !cue.segmentId) ? 'cue_segment_unassigned' : 'cue_segment_mismatch';
        error.rejectedCueIds = rejectedCues.map((cue) => cue.cueId);
        ownershipError = true;
        onStatusChange?.('error');
        onError?.(error);
        if (acceptedCues.length === 0) throw error;
      }
      for (const cue of acceptedCues) {
        const key = cueKey(context, cue);
        const existing = pendingCues.get(key);
        const candidates = [...(existing ? [existing] : []), ...(pendingCueVariants.get(key) || []), { ...cue }];
        const maximal = candidates.filter((candidate, index) => !candidates.some((other, otherIndex) =>
          otherIndex !== index && cueCovers(other, candidate) &&
          (!cueCovers(candidate, other) || otherIndex > index)));
        pendingCues.set(key, maximal[0]);
        if (maximal.length > 1) pendingCueVariants.set(key, maximal.slice(1));
        else pendingCueVariants.delete(key);
      }
      if (checkpoint) pendingCueCheckpoints.set(scopeKey(context), checkpoint);
      if (hasPendingFor(context) && !timer && !retryTimers.has(scopeKey(context))) {
        const scheduledContext = { ...context };
        timer = setTimeoutFn(() => { timer = null; void enqueueFlush(scheduledContext); }, Math.max(0, delayMs));
      }
      return { acceptedCueIds: acceptedCues.map((cue) => cue.cueId), rejectedCueIds: rejectedCues.map((cue) => cue.cueId) };
    },

    flush() {
      clearTimer();
      if (context) clearRetryTimer(context);
      return enqueueFlush(context ? { ...context } : null);
    },

    cancel() {
      clearTimer();
      clearRetryTimers();
      conflictRetries.clear();
      contextGeneration += 1;
      context = null;
      onStatusChange?.('idle');
    }
  });

  function enqueueFlush(flushContext = context) {
    queue = queue.then(() => flushPending(flushContext));
    return queue;
  }

  async function flushPending(flushContext) {
    if (!flushContext) return true;
    const flushScope = scopeKey(flushContext);
    const chunks = sortedChunks(Array.from(pendingChunks.values()).filter((chunk) => (
      chunk.meetingId === flushContext.meetingId && chunk.segmentId === flushContext.segmentId
    )));
    const cues = [...pendingCues.entries()]
      .filter(([key]) => key.startsWith(`${flushScope}:`))
      .map(([, cue]) => cue)
      .sort((left, right) => left.sequence - right.sequence);
    const payloadCheckpoint = pendingCueCheckpoints.get(flushScope) || null;
    if (chunks.length === 0 && cues.length === 0 && !payloadCheckpoint) return true;

    onStatusChange?.('syncing');

    try {
      const payload = {
        meetingId: flushContext.meetingId,
        segmentId: flushContext.segmentId,
        durableChunks: chunks,
        finalCues: cues,
        cueCheckpoint: payloadCheckpoint,
        refinedSubtitleCues: payloadCheckpoint?.refinedSubtitleCues,
        refinedSubtitleRevision: payloadCheckpoint?.refinedSubtitleRevision,
        refinedSubtitleInputHash: payloadCheckpoint?.refinedSubtitleInputHash,
        refinedSubtitleStatus: payloadCheckpoint?.refinedSubtitleStatus
      };
      payload.idempotencyKey = checkpointOperationKey(flushContext.segmentId, payload);
      const committed = await updateCheckpoint(payload);
      if (!committed?.checkpoint || !checkpointCoversFlush(committed, flushContext, chunks, cues, payloadCheckpoint)) {
        throw checkpointConflict('committed checkpoint does not cover the requested flush');
      }

      for (const chunk of chunks) {
        const key = chunkKey(chunk);
        const pending = pendingChunks.get(key);
        if (pending && sameChunk(pending, chunk)) pendingChunks.delete(key);
      }
      for (const cue of cues) {
        const key = cueKey(flushContext, cue);
        const pending = pendingCues.get(key);
        if (pending && cueCovers(cue, pending)) promotePendingCue(key);
      }
      if (pendingCueCheckpoints.has(flushScope) &&
          sameCueCheckpoint(pendingCueCheckpoints.get(flushScope), payloadCheckpoint)) {
        pendingCueCheckpoints.delete(flushScope);
      }
      clearRetryTimer(flushContext);
      conflictRetries.delete(flushScope);
      if (isActiveContext(flushContext)) {
        onStatusChange?.(ownershipError ? 'error' : hasPendingFor(flushContext) ? 'ready' : 'synced');
      }
      return true;
    } catch (error) {
      if (error?.status === 409 && getCheckpoint) {
        try {
          const latest = await getCheckpoint({
            meetingId: flushContext.meetingId,
            segmentId: flushContext.segmentId
          });
          reconcilePendingWithCheckpoint(latest, flushContext);
          if (hasPendingFor(flushContext)) {
            const attempts = (conflictRetries.get(flushScope) || 0) + 1;
            conflictRetries.set(flushScope, attempts);
            if (attempts <= MAX_CONFLICT_RETRIES) {
              if (isActiveContext(flushContext)) onStatusChange?.('ready');
              scheduleRetry(flushContext);
            } else {
              if (isActiveContext(flushContext)) onStatusChange?.('error');
              onError?.(error);
            }
          } else {
            conflictRetries.delete(flushScope);
            if (isActiveContext(flushContext)) onStatusChange?.('synced');
          }
          return false;
        } catch (reconcileError) {
          onError?.(reconcileError);
        }
      }

      if (isActiveContext(flushContext)) onStatusChange?.('error');
      onError?.(error);
      if (isRetryableCheckpointError(error)) scheduleRetry(flushContext);
      return false;
    }
  }

  function clearTimer() {
    if (!timer) return;
    clearTimeoutFn(timer);
    timer = null;
  }

  function scheduleRetry(retryContext) {
    const key = scopeKey(retryContext);
    if (retryTimers.has(key)) return;
    const retryTimer = setTimeoutFn(() => {
      retryTimers.delete(key);
      void enqueueFlush(retryContext);
    }, Math.max(0, retryDelayMs));
    retryTimers.set(key, retryTimer);
  }

  function clearRetryTimer(retryContext) {
    const key = scopeKey(retryContext);
    const retryTimer = retryTimers.get(key);
    if (!retryTimer) return;
    clearTimeoutFn(retryTimer);
    retryTimers.delete(key);
  }

  function clearRetryTimers() {
    for (const retryTimer of retryTimers.values()) clearTimeoutFn(retryTimer);
    retryTimers.clear();
  }

  function reconcilePendingWithCheckpoint(latest, checkpointContext) {
    if ((latest?.meetingId && latest.meetingId !== checkpointContext.meetingId) ||
        (latest?.segmentId && latest.segmentId !== checkpointContext.segmentId)) return;
    const checkpoint = latest?.checkpoint;
    const persistedChunks = Array.isArray(checkpoint?.durableChunks) ? checkpoint.durableChunks : [];
    const persistedByKey = new Map(persistedChunks.map((chunk) => [chunk?.idempotencyKey, chunk]));
    const persistedBySequence = new Map(persistedChunks.map((chunk) => [`${chunk?.stream}:${chunk?.sequence}`, chunk]));

    for (const [key, pending] of pendingChunks) {
      if (pending.meetingId !== checkpointContext.meetingId || pending.segmentId !== checkpointContext.segmentId) continue;
      const persisted = persistedByKey.get(key) || persistedBySequence.get(`${pending.stream}:${pending.sequence}`);
      if (persisted && sameChunk(persisted, pending)) {
        pendingChunks.delete(key);
      }
    }

    const persistedCues = new Map((Array.isArray(checkpoint?.finalCues) ? checkpoint.finalCues : [])
      .map((cue) => [cueKey(checkpointContext, cue), cue]));
    for (const [key, pending] of pendingCues) {
      if (!key.startsWith(`${scopeKey(checkpointContext)}:`)) continue;
      const persisted = persistedCues.get(key);
      const sameOwner = persisted?.cueId === pending.cueId &&
        persisted?.sessionId === pending.sessionId && persisted?.segmentId === pending.segmentId;
    if (sameOwner && sameCueSnapshot(persisted, pending)) {
      promotePendingCue(key);
      }
    }

    if (latest?.meetingId === checkpointContext.meetingId &&
        latest?.segmentId === checkpointContext.segmentId &&
        pendingCueCheckpoints.has(scopeKey(checkpointContext)) &&
        sameCueCheckpoint(pendingCueCheckpoints.get(scopeKey(checkpointContext)), checkpoint?.cueCheckpoint)) {
      pendingCueCheckpoints.delete(scopeKey(checkpointContext));
    }
  }

  function isActiveContext(candidate) {
    return context?.meetingId === candidate.meetingId && context?.segmentId === candidate.segmentId;
  }

  function hasPendingFor(candidate) {
    const scope = scopeKey(candidate);
    return [...pendingChunks.values()].some((chunk) => chunk.meetingId === candidate.meetingId && chunk.segmentId === candidate.segmentId)
      || [...pendingCues.keys()].some((key) => key.startsWith(`${scope}:`))
      || pendingCueCheckpoints.has(scope);
  }

  function promotePendingCue(key) {
    const variants = pendingCueVariants.get(key) || [];
    if (variants.length === 0) {
      pendingCues.delete(key);
      pendingCueVariants.delete(key);
      return;
    }
    pendingCues.set(key, variants[0]);
    if (variants.length === 1) pendingCueVariants.delete(key);
    else pendingCueVariants.set(key, variants.slice(1));
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

function checkpointCoversFlush(result, scope, chunks, cues, cueCheckpoint) {
  if (result.meetingId !== scope.meetingId || result.segmentId !== scope.segmentId) return false;
  const checkpoint = result.checkpoint;
  const storedChunks = new Map((checkpoint.durableChunks || []).map((chunk) => [chunk.idempotencyKey, chunk]));
  const storedCues = new Map((checkpoint.finalCues || []).map((cue) => [cueKey(scope, cue), cue]));
  return chunks.every((chunk) => sameChunk(storedChunks.get(chunk.idempotencyKey), chunk)) &&
    cues.every((cue) => cueCovers(storedCues.get(cueKey(scope, cue)), cue)) &&
    (!cueCheckpoint || sameCueCheckpoint(checkpoint.cueCheckpoint, cueCheckpoint));
}

function scopeKey(value) {
  return JSON.stringify([value.meetingId, value.segmentId]);
}

function chunkKey(chunk) {
  return `${scopeKey(chunk)}:${chunk.idempotencyKey}`;
}

function cueKey(context, cue) {
  return `${scopeKey(context)}:${JSON.stringify([cue.sessionId, cue.cueId])}`;
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

function cueCovers(persisted, pending) {
  if (!persisted || !pending ||
      persisted.cueId !== pending.cueId ||
      persisted.sessionId !== pending.sessionId ||
      persisted.segmentId !== pending.segmentId) return false;

  let remote;
  let local;
  try {
    remote = validateFinalCue(persisted);
    local = validateFinalCue(pending);
  } catch {
    // Invalid legacy shapes cannot establish a newer-version durability proof.
    return sameValue(persisted, pending);
  }

  const identity = ['cueId', 'sessionId', 'segmentId', 'sequence', 'startTimeMs',
    'sourceLanguageCode', 'targetLanguageCode', 'mode', 'status', 'finalizedReason'];
  if (!identity.every((field) => remote[field] === local[field])) return false;
  if (remote.endTimeMs < local.endTimeMs) return false;
  if (!sideCovers(remote, local, 'source') || !sideCovers(remote, local, 'translation')) return false;
  if (remote.endTimeMs > local.endTimeMs &&
      remote.sourceVersion === local.sourceVersion &&
      remote.translationVersion === local.translationVersion) return false;

  if (!Object.hasOwn(local, 'refinement')) return true;
  if (!Object.hasOwn(remote, 'refinement')) return false;
  if (local.initialTranslation !== null &&
      remote.initialTranslation !== local.initialTranslation) return false;
  if (local.initialTranslation === null && remote.initialTranslation !== null &&
      remote.translationVersion <= local.translationVersion) return false;

  const localRefinement = local.refinement;
  const remoteRefinement = remote.refinement;
  if (remoteRefinement.version < localRefinement.version) return false;
  if (remoteRefinement.version === localRefinement.version) {
    return sameValue(remoteRefinement, localRefinement) &&
      remote.refinedSource === local.refinedSource &&
      remote.refinedTranslation === local.refinedTranslation;
  }
  if (remoteRefinement.inputHash !== localRefinement.inputHash) return false;
  if (localRefinement.status === 'completed' && remoteRefinement.status !== 'completed') return false;
  if (local.refinedSource !== null && remote.refinedSource === null) return false;
  if (local.refinedTranslation !== null && remote.refinedTranslation === null) return false;
  return true;
}

function sideCovers(remote, local, side) {
  const version = side === 'source' ? 'sourceVersion' : 'translationVersion';
  const content = side === 'source' ? 'sourceText' : 'translatedText';
  const status = side === 'source' ? 'sourceStatus' : 'translationStatus';
  if (remote[version] < local[version]) return false;
  if (remote[version] === local[version]) {
    return remote[content] === local[content] && remote[status] === local[status];
  }
  if (!remote[content].startsWith(local[content])) return false;
  return remote[status] === local[status] ||
    (local[status] === 'pending' && ['finalized', 'unavailable'].includes(remote[status]));
}

function sameCueSnapshot(left, right) {
  try {
    return sameValue(validateFinalCue(left), validateFinalCue(right));
  } catch {
    return sameValue(left, right);
  }
}

function sameCueCheckpoint(left, right) {
  const local = normalizeCueCheckpoint(left);
  const remote = normalizeCueCheckpoint(right);
  return local !== null && remote !== null && sameValue(local, remote);
}

function sameValue(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) &&
      left.length === right.length && left.every((value, index) => sameValue(value, right[index]));
  }
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => Object.hasOwn(right, key) && sameValue(left[key], right[key]));
}
