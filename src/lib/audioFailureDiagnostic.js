const STAGES = new Set([
  'PCM_CAPTURE', 'AUDIO_WRITER_INIT', 'AUDIO_CHUNK_ENQUEUE',
  'AUDIO_CHUNK_WRITE', 'AUDIO_WRITER_FLUSH', 'AUDIO_WRITER_CLOSE',
  'AUDIO_SEGMENT_COMMIT', 'AUDIO_ERROR_MAPPING'
]);
const ERROR_CODES = new Set([
  'MEDIA_RECORDER_UNSUPPORTED', 'MEDIA_RECORDER_ERROR',
  'MICROPHONE_STREAM_MISSING', 'WEBM_UNSUPPORTED',
  'MEETING_LOCK_UNAVAILABLE', 'JOURNAL_NOT_OPEN', 'JOURNAL_WORKER_TIMEOUT',
  'JOURNAL_WORKER_ERROR', 'OPFS_SHORT_WRITE', 'PCM_VERIFY_FAILED',
  'PCM_TRUNCATED', 'LEDGER_COMMIT_UNKNOWN', 'JOURNAL_STORAGE_LIMIT',
  'JOURNAL_INDEX_LIMIT', 'SAMPLE_RANGE_OVERLAP', 'CAPTURE_EPOCH_CLOSED',
  'BACKPRESSURE_GAP', 'INTEGRITY_UNRESOLVED'
]);
const ERROR_NAMES = new Set([
  'Error', 'TypeError', 'AbortError', 'QuotaExceededError', 'NotFoundError',
  'InvalidStateError', 'NotAllowedError', 'NotSupportedError', 'SecurityError',
  'UnknownError', 'OperationError', 'DataError', 'ConstraintError',
  'TransactionInactiveError', 'TimeoutError', 'NetworkError'
]);
const segmentCodes = new Map();
const AUDIO_PATHS = new Set(['ORIGINAL_AUDIO', 'PCM_JOURNAL', 'TRANSLATED_AUDIO']);
const OPFS_WRITE_OPERATIONS = new Set([
  'PARENT_DIRECTORY', 'FILE_LOOKUP', 'FILE_CREATE',
  'WRITABLE_CREATE', 'WRITABLE_WRITE', 'WRITABLE_CLOSE'
]);
const listeners = new Set();
let snapshot = { events: [], recorderMimeType: '', recordedChunk: false };

export function getAudioDiagnosticSnapshot() {
  return snapshot;
}

export function subscribeAudioDiagnostics(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function publish(patch) {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) {
    try { listener(); } catch { /* Diagnostics must not affect recording. */ }
  }
}

export function recordAudioRecorderState({ mimeType = '', chunkRecorded = false } = {}) {
  // Only known container/codec labels may enter a screenshot or clipboard summary.
  const safeMimeType = /^(audio\/webm(?:;codecs=opus)?|audio\/mp4(?:;codecs=mp4a\.40\.2)?|audio\/ogg;codecs=opus)$/iu.test(mimeType)
    ? mimeType.toLowerCase() : 'unknown';
  publish({ recorderMimeType: safeMimeType, recordedChunk: Boolean(chunkRecorded) });
}

export function recordAudioFailure({ audioPath, stage, operation, error, writerState, queueDepth,
  chunkBytes, segmentId, elapsedMs } = {}) {
  if (!STAGES.has(stage)) return;
  const safeWord = (value) => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(value)
    ? value : null;
  const safeCount = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
  let segmentCode = null;
  if (typeof segmentId === 'string' && segmentId) {
    if (!segmentCodes.has(segmentId)) {
      if (segmentCodes.size >= 64) segmentCodes.delete(segmentCodes.keys().next().value);
      segmentCodes.set(segmentId, `segment_${Math.random().toString(36).slice(2, 10)}`);
    }
    segmentCode = segmentCodes.get(segmentId);
  }
  const detail = {
    audioPath: AUDIO_PATHS.has(audioPath) ? audioPath : null,
    stage,
    operation: safeWord(operation),
    storageOperation: OPFS_WRITE_OPERATIONS.has(error?.opfsOperation) ? error.opfsOperation : null,
    errorOrigin: typeof globalThis.DOMException === 'function' && error instanceof globalThis.DOMException
      ? 'DOM_EXCEPTION' : 'OTHER',
    errorName: ERROR_CODES.has(error?.code) || ERROR_NAMES.has(error?.code) ? error.code
      : ERROR_NAMES.has(error?.name) ? error.name : 'UNCLASSIFIED',
    writerState: safeWord(writerState),
    queueDepth: safeCount(queueDepth),
    chunkBytes: safeCount(chunkBytes),
    segmentId: segmentCode,
    elapsedMs: safeCount(elapsedMs)
  };
  publish({ events: [...snapshot.events, {
    audioPath: detail.audioPath,
    stage: detail.stage,
    code: detail.errorName,
    storageOperation: detail.storageOperation,
    errorOrigin: detail.errorOrigin,
    at: new Date().toISOString()
  }].slice(-10) });
  try { console.info('ISSUE41_AUDIO_FAILURE', detail); } catch { /* Diagnostics must not affect recording. */ }
}
