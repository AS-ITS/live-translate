export const DEFAULT_TRANSCRIPT_POLISHING_INTERVAL_MS = 30000;
export const DEFAULT_TRANSCRIPT_POLISHING_MIN_CHARS = 200;

export function createTranscriptPolishingCoordinator({
  intervalMs = DEFAULT_TRANSCRIPT_POLISHING_INTERVAL_MS,
  minChars = DEFAULT_TRANSCRIPT_POLISHING_MIN_CHARS,
  maxRequestsPerMinute = 15,
  now = () => Date.now(),
  submit,
  onStateChange
} = {}) {
  if (!Number.isInteger(intervalMs) || intervalMs <= 0) throw new TypeError('intervalMs must be a positive integer.');
  if (!Number.isInteger(minChars) || minChars <= 0) throw new TypeError('minChars must be a positive integer.');
  if (!Number.isInteger(maxRequestsPerMinute) || maxRequestsPerMinute <= 0) throw new TypeError('maxRequestsPerMinute must be a positive integer.');
  if (typeof submit !== 'function') throw new TypeError('submit must be a function.');

  let stableCues = [];
  let lastSubmittedAt = 0;
  let inFlight = false;
  let dirty = false;
  let lastHash = null;
  const processedCueIds = new Set();
  const submissionTimes = [];

  function add(cues = [], { force = false } = {}) {
    const next = mergeStableCues(stableCues, cues);
    const changed = next.length !== stableCues.length || next.some((cue, index) => cueSignature(cue) !== cueSignature(stableCues[index]));
    stableCues = next;
    if (!changed) return Promise.resolve(null);
    if (inFlight) {
      dirty = true;
      emit('dirty');
      return Promise.resolve(null);
    }
    if (!force && !thresholdReached(pendingCues(), lastSubmittedAt, now(), intervalMs, minChars)) return Promise.resolve(null);
    return submitPending();
  }

  function flush() {
    if (pendingCues().length === 0 || inFlight) {
      if (inFlight && pendingCues().length > 0) dirty = true;
      return Promise.resolve(null);
    }
    return submitPending();
  }

  function submitPending() {
    const snapshot = pendingCues().map((cue) => ({ ...cue }));
    if (snapshot.length === 0) return Promise.resolve(null);
    const currentTime = now();
    while (submissionTimes[0] !== undefined && currentTime - submissionTimes[0] >= 60000) submissionTimes.shift();
    if (submissionTimes.length >= maxRequestsPerMinute) {
      emit('rate_limited');
      return Promise.resolve(null);
    }
    const inputHash = transcriptPolishingInputHash(snapshot);
    if (inputHash === lastHash) return Promise.resolve(null);
    inFlight = true;
    dirty = false;
    emit('running');
    return Promise.resolve(submit({
      cues: snapshot,
      inputHash,
      segmentRange: segmentRangeFor(snapshot)
    })).then((result) => {
      lastHash = inputHash;
      submissionTimes.push(now());
      snapshot.forEach((cue) => processedCueIds.add(cue.cueId));
      lastSubmittedAt = now();
      inFlight = false;
      emit('queued');
      if (dirty) return submitPending();
      return result;
    }).catch((error) => {
      inFlight = false;
      emit('failed', error);
      throw error;
    });
  }

  function reset() {
    stableCues = [];
    lastSubmittedAt = 0;
    inFlight = false;
    dirty = false;
    lastHash = null;
    processedCueIds.clear();
    emit('idle');
  }

  return Object.freeze({ add, flush, reset, state: () => ({ inFlight, dirty, lastHash, stableCueCount: stableCues.length }) });

  function emit(status, error) {
    onStateChange?.({ status, inFlight, dirty, stableCueCount: stableCues.length, ...(error ? { error } : {}) });
  }

  function pendingCues() {
    return stableCues.filter((cue) => !processedCueIds.has(cue.cueId));
  }
}

export function thresholdReached(cues, lastSubmittedAt, currentTime, intervalMs, minChars) {
  if (!Array.isArray(cues) || cues.length === 0) return false;
  const textLength = cues.reduce((total, cue) => total + String(cue?.translationText || '').length, 0);
  return textLength >= minChars || currentTime - lastSubmittedAt >= intervalMs;
}

export function mergeStableCues(existing = [], incoming = []) {
  const byId = new Map();
  for (const cue of [...existing, ...incoming]) {
    if (cue?.status !== 'final' || !cue.cueId || typeof cue.translationText !== 'string' || cue.translationText.trim() === '') continue;
    byId.set(cue.cueId, { ...cue, sourceText: String(cue.sourceText || ''), translationText: cue.translationText });
  }
  return [...byId.values()].sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0));
}

export function transcriptPolishingInputHash(cues = []) {
  const value = JSON.stringify(cues.map(({ cueId, sequence, sourceText, translationText }) => ({ cueId, sequence, sourceText, translationText })));
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function segmentRangeFor(cues = []) {
  return {
    fromSequence: cues[0]?.sequence ?? null,
    toSequence: cues.at(-1)?.sequence ?? null,
    segmentIds: [...new Set(cues.map((cue) => cue.segmentId).filter(Boolean))]
  };
}

function cueSignature(cue) {
  return `${cue?.cueId || ''}:${cue?.sequence || ''}:${cue?.sourceText || ''}:${cue?.translationText || ''}`;
}
