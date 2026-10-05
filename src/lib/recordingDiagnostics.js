import { createLatencyHistogram, percentileFromLatencyHistogram, recordLatency } from './latencyHistogram.js';

const DEFAULT_SAMPLE_INTERVAL_MS = 1000;
const CALLBACK_GAP_REPORT_MS = 250;

export function createRecordingDiagnostics({
  enabled = true,
  now = () => Date.now(),
  performanceImpl = globalThis.performance,
  windowImpl = globalThis,
  PerformanceObserverImpl = globalThis.PerformanceObserver,
  sampleIntervalMs = DEFAULT_SAMPLE_INTERVAL_MS
} = {}) {
  let state = emptyState();
  let longTaskObserver = null;
  let sampleTimer = null;

  function reset({ mimeType = '' } = {}) {
    stopRuntimeProbe();
    state = emptyState();
    state.mimeType = typeof mimeType === 'string' ? mimeType : '';
    state.recordingStartedAt = now();
    sampleMemory();
    startRuntimeProbe();
  }

  function recordRecorderChunk(chunk) {
    if (!enabled || !chunk) return;
    const byteSize = byteSizeFor(chunk);
    if (byteSize < 1) return;
    const at = now();
    const gap = state.lastChunkAt === null ? null : Math.max(0, at - state.lastChunkAt);
    state.chunkCount += 1;
    state.totalChunkBytes += byteSize;
    state.maxChunkBytes = Math.max(state.maxChunkBytes, byteSize);
    state.maxChunkCallbackGapMs = Math.max(state.maxChunkCallbackGapMs, gap || 0);
    if (gap !== null) {
      recordLatency(state.chunkCallbackGapHistogram, gap);
      state.chunkCallbackGapP95Ms = percentileFromLatencyHistogram(state.chunkCallbackGapHistogram);
      if (gap >= CALLBACK_GAP_REPORT_MS) state.chunkCallbackGapCount += 1;
    }
    state.lastChunkAt = at;
    if (!state.mimeType && typeof chunk.type === 'string') state.mimeType = chunk.type;
    sampleMemory();
  }

  function beginFinalize() {
    if (!enabled) return;
    state.finalizeStartedAt ??= now();
  }

  function finishFinalize(blob) {
    if (!enabled) return;
    const finishedAt = now();
    state.finalizeDurationMs = state.finalizeStartedAt === null
      ? null
      : Math.max(0, finishedAt - state.finalizeStartedAt);
    state.finalizedBlobBytes = byteSizeFor(blob);
    sampleMemory();
  }

  function beginUpload({ byteSize = 0 } = {}) {
    if (!enabled) return;
    state.upload = {
      status: 'uploading',
      startedAt: now(),
      durationMs: null,
      byteSize: Number.isFinite(byteSize) ? Math.max(0, byteSize) : 0,
      uploadedBytes: 0,
      retryCount: 0,
      errorCode: null
    };
  }

  function recordUploadProgress({ uploadedBytes = 0 } = {}) {
    if (!enabled || !state.upload) return;
    if (Number.isFinite(uploadedBytes)) {
      state.upload.uploadedBytes = Math.max(state.upload.uploadedBytes, uploadedBytes);
    }
  }

  function recordUploadRetry() {
    if (!enabled || !state.upload) return;
    state.upload.retryCount += 1;
  }

  function completeUpload({ status = 'ready' } = {}) {
    finishUpload(status);
  }

  function failUpload({ errorCode = null } = {}) {
    finishUpload('failed', errorCode);
  }

  function finishUpload(status, errorCode = null) {
    if (!enabled || !state.upload) return;
    const finishedAt = now();
    state.upload = {
      ...state.upload,
      status,
      durationMs: Math.max(0, finishedAt - state.upload.startedAt),
      errorCode: typeof errorCode === 'string' ? errorCode : null
    };
    sampleMemory();
  }

  function snapshot() {
    return clone(state);
  }

  function destroy() {
    stopRuntimeProbe();
  }

  function startRuntimeProbe() {
    if (!enabled) return;
    if (typeof PerformanceObserverImpl === 'function') {
      try {
        longTaskObserver = new PerformanceObserverImpl((list) => {
          for (const entry of list.getEntries()) {
            state.longTaskCount += 1;
            state.maxLongTaskMs = Math.max(state.maxLongTaskMs, Number(entry.duration) || 0);
          }
        });
        longTaskObserver.observe({ entryTypes: ['longtask'] });
      } catch {
        longTaskObserver = null;
      }
    }
    const isExplicitWindow = windowImpl !== globalThis;
    const isBrowserGlobal = windowImpl === globalThis && typeof windowImpl.window !== 'undefined';
    if (typeof windowImpl?.setInterval === 'function' && (isExplicitWindow || isBrowserGlobal)) {
      sampleTimer = windowImpl.setInterval(sampleMemory, sampleIntervalMs);
    }
  }

  function stopRuntimeProbe() {
    longTaskObserver?.disconnect?.();
    longTaskObserver = null;
    if (sampleTimer !== null) windowImpl?.clearInterval?.(sampleTimer);
    sampleTimer = null;
    sampleMemory();
  }

  function sampleMemory() {
    const heapBytes = heapBytesFor(performanceImpl);
    if (heapBytes === null) return;
    state.heapStartBytes ??= heapBytes;
    state.heapPeakBytes = Math.max(state.heapPeakBytes ?? heapBytes, heapBytes);
    state.heapEndBytes = heapBytes;
  }

  return Object.freeze({
    reset,
    recordRecorderChunk,
    beginFinalize,
    finishFinalize,
    beginUpload,
    recordUploadProgress,
    recordUploadRetry,
    completeUpload,
    failUpload,
    snapshot,
    destroy
  });
}

function emptyState() {
  return {
    mimeType: '',
    recordingStartedAt: null,
    chunkCount: 0,
    totalChunkBytes: 0,
    maxChunkBytes: 0,
    maxChunkCallbackGapMs: 0,
    chunkCallbackGapCount: 0,
    chunkCallbackGapP95Ms: 0,
    chunkCallbackGapHistogram: createLatencyHistogram(),
    lastChunkAt: null,
    finalizeStartedAt: null,
    finalizeDurationMs: null,
    finalizedBlobBytes: 0,
    upload: null,
    longTaskCount: 0,
    maxLongTaskMs: 0,
    heapStartBytes: null,
    heapPeakBytes: null,
    heapEndBytes: null
  };
}

function byteSizeFor(value) {
  if (Number.isFinite(value?.size)) return Math.max(0, value.size);
  if (Number.isFinite(value?.byteLength)) return Math.max(0, value.byteLength);
  return 0;
}

function heapBytesFor(performanceImpl) {
  const value = performanceImpl?.memory?.usedJSHeapSize;
  return Number.isFinite(value) ? Math.max(0, value) : null;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
