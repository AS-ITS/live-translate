import { createLatencyHistogram, percentileFromLatencyHistogram, recordLatency } from './latencyHistogram.js';

export const RECORDING_DIAGNOSTIC_SCHEMA_VERSION = 'recording-diagnostics/v1';
export const RECORDING_DIAGNOSTIC_SAMPLE_CAPACITY = 256;
const DEFAULT_SAMPLE_INTERVAL_MS = 30_000;
const CALLBACK_GAP_REPORT_MS = 250;

export function createRecordingDiagnostics({
  enabled = true,
  now = () => Date.now(),
  performanceImpl = globalThis.performance,
  navigatorImpl = globalThis.navigator,
  windowImpl = globalThis,
  PerformanceObserverImpl = globalThis.PerformanceObserver,
  sampleIntervalMs = DEFAULT_SAMPLE_INTERVAL_MS,
  buildSha = import.meta.env?.VITE_VERCEL_GIT_COMMIT_SHA || import.meta.env?.VITE_GIT_COMMIT_SHA || null
} = {}) {
  let state = emptyState();
  let longTaskObserver = null;
  let sampleTimer = null;
  let completed = false;

  function reset({ mimeType = '' } = {}) {
    stopRuntimeProbe();
    state = emptyState();
    completed = false;
    state.sampleIntervalMs = sampleIntervalMs;
    state.mimeType = typeof mimeType === 'string' ? mimeType : '';
    state.recordingStartedAt = now();
    sample();
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
  }

  function setPcmQueue({ chunks = 0, bytes = 0, maxChunks = null, maxBytes = null } = {}) {
    if (!enabled) return;
    setCurrent('pcmPendingChunks', chunks);
    setCurrent('pcmPendingBytes', bytes);
    state.limits.pcmPendingChunks = finiteOrNull(maxChunks);
    state.limits.pcmPendingBytes = finiteOrNull(maxBytes);
  }

  function recordPcmDrop({ bytes = 0, durationMs = 0 } = {}) {
    if (!enabled) return;
    increment('pcmDroppedChunks', 1);
    increment('pcmDroppedBytes', bytes);
    increment('pcmDroppedDurationMs', durationMs);
  }

  function recordBlobQueued(value) {
    if (!enabled) return;
    const bytes = byteSizeFor(value);
    setCurrent('blobBacklogCount', state.current.blobBacklogCount + 1);
    setCurrent('blobBacklogBytes', state.current.blobBacklogBytes + bytes);
  }

  function recordBlobSettled(value, { failed = false, cancelled = false } = {}) {
    if (!enabled) return;
    const bytes = byteSizeFor(value);
    setCurrent('blobBacklogCount', state.current.blobBacklogCount - 1);
    setCurrent('blobBacklogBytes', state.current.blobBacklogBytes - bytes);
    if (failed) increment('blobWriteFailures', 1);
    if (cancelled) increment('blobWriteCancellations', 1);
  }

  function recordOpfsAppendStarted({ bytes = 0 } = {}) {
    if (!enabled) return;
    setCurrent('opfsPendingCount', state.current.opfsPendingCount + 1);
    setCurrent('opfsPendingBytes', state.current.opfsPendingBytes + bytes);
    increment('opfsAppendAttempts', 1);
  }

  function recordOpfsAppendFinished({ bytes = 0, durationMs = 0, status = 'sealed', newlySealed = true } = {}) {
    if (!enabled) return;
    setCurrent('opfsPendingCount', state.current.opfsPendingCount - 1);
    setCurrent('opfsPendingBytes', state.current.opfsPendingBytes - bytes);
    const latency = Math.max(0, Number(durationMs) || 0);
    recordLatency(state.latency.opfsAppend.histogram, latency);
    state.latency.opfsAppend.count += 1;
    state.latency.opfsAppend.maxMs = Math.max(state.latency.opfsAppend.maxMs, latency);
    const p95UpperBoundMs = percentileFromLatencyHistogram(state.latency.opfsAppend.histogram);
    const rank = Math.ceil(state.latency.opfsAppend.count * 0.95);
    const belowOverflowCount = state.latency.opfsAppend.count - state.latency.opfsAppend.histogram.gte3000;
    const overflow = rank > belowOverflowCount;
    state.latency.opfsAppend.p95Status = overflow ? 'overflow_bucket' : 'bounded';
    state.latency.opfsAppend.p95UpperBoundMs = overflow ? null : p95UpperBoundMs;
    state.latency.opfsAppend.p95LowerBoundMs = overflow ? 3000 : null;
    if (status === 'sealed') {
      increment('opfsAppendSuccesses', 1);
      if (newlySealed) {
        setCurrent('opfsSealedBytes', state.current.opfsSealedBytes + bytes);
        setCurrent('opfsUnsealedCount', state.current.opfsUnsealedCount - 1);
      }
    } else if (status === 'cancelled') {
      increment('opfsAppendCancellations', 1);
    } else {
      increment('opfsAppendFailures', 1);
    }
  }

  function recordOpfsChunkReserved({ bytes = 0, isRetry = false } = {}) {
    if (!enabled || isRetry) return;
    setCurrent('opfsUnsealedCount', state.current.opfsUnsealedCount + 1);
    setCurrent('opfsUnsealedBytes', state.current.opfsUnsealedBytes + bytes);
  }

  function recordOpfsChunkSealed({ bytes = 0, wasUnsealed = true } = {}) {
    if (!enabled || !wasUnsealed) return;
    setCurrent('opfsUnsealedBytes', state.current.opfsUnsealedBytes - bytes);
  }

  function recordOpfsChunkDiscarded({ bytes = 0 } = {}) {
    if (!enabled) return;
    setCurrent('opfsUnsealedCount', state.current.opfsUnsealedCount - 1);
    setCurrent('opfsUnsealedBytes', state.current.opfsUnsealedBytes - bytes);
  }

  function setOpfsManifest({ sealedBytes = 0, unsealedCount = 0, unsealedBytes = 0 } = {}) {
    if (!enabled) return;
    setCurrent('opfsSealedBytes', sealedBytes);
    setCurrent('opfsUnsealedCount', unsealedCount);
    setCurrent('opfsUnsealedBytes', unsealedBytes);
  }

  function setLegacyQueue({ chunks = 0, bytes = 0 } = {}) {
    if (!enabled) return;
    setCurrent('legacyInputChunks', chunks);
    setCurrent('legacyInputBytes', bytes);
  }

  function recordLegacyRetry() {
    if (enabled) increment('legacyInputRetries', 1);
  }

  function setCollectionCounts(counts = {}) {
    if (!enabled) return;
    for (const key of ['cueCount', 'snapshotCueCount', 'replayEventCount', 'diagnosticEntryCount', 'diagnosticMapCount']) {
      if (Object.hasOwn(counts, key)) setCurrent(key, counts[key]);
    }
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

  function exportJson() {
    const exportedAt = now();
    return JSON.stringify({
      schemaVersion: RECORDING_DIAGNOSTIC_SCHEMA_VERSION,
      buildSha: typeof buildSha === 'string' && buildSha ? buildSha : null,
      exportedAt,
      recordingRelativeMs: state.recordingStartedAt === null ? null : Math.max(0, exportedAt - state.recordingStartedAt),
      browser: {
        userAgent: typeof navigatorImpl?.userAgent === 'string' ? navigatorImpl.userAgent : null,
        capabilities: {
          mediaRecorder: typeof windowImpl?.MediaRecorder === 'function',
          opfs: typeof navigatorImpl?.storage?.getDirectory === 'function',
          webRtc: typeof windowImpl?.RTCPeerConnection === 'function',
          audioContext: typeof (windowImpl?.AudioContext || windowImpl?.webkitAudioContext) === 'function',
          jsHeap: heapBytesFor(performanceImpl) === null ? 'unavailable' : 'available'
        }
      },
      diagnostics: snapshot()
    }, null, 2);
  }

  function sample() {
    if (!enabled) return null;
    sampleMemory();
    const sampledAt = now();
    const value = Object.freeze({
      sampledAt,
      recordingRelativeMs: state.recordingStartedAt === null ? null : Math.max(0, sampledAt - state.recordingStartedAt),
      current: clone(state.current),
      cumulative: clone(state.cumulative),
      highWater: clone(state.highWater),
      latency: clone(state.latency),
      heap: clone(state.heap)
    });
    if (state.samples.length >= RECORDING_DIAGNOSTIC_SAMPLE_CAPACITY) {
      state.samples.shift();
      state.droppedSampleCount += 1;
    }
    state.samples.push(value);
    return clone(value);
  }

  function complete() {
    if (!enabled || completed) return;
    completed = true;
    sample();
    stopRuntimeProbe({ sampleAtStop: false });
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
      sampleTimer = windowImpl.setInterval(sample, sampleIntervalMs);
    }
  }

  function stopRuntimeProbe({ sampleAtStop = true } = {}) {
    longTaskObserver?.disconnect?.();
    longTaskObserver = null;
    if (sampleTimer !== null) windowImpl?.clearInterval?.(sampleTimer);
    sampleTimer = null;
    if (sampleAtStop) sampleMemory();
  }

  function sampleMemory() {
    const heapBytes = heapBytesFor(performanceImpl);
    if (heapBytes === null) {
      state.heap = { status: 'unavailable', startBytes: null, peakBytes: null, endBytes: null };
      return;
    }
    state.heap.status = 'available';
    state.heap.startBytes ??= heapBytes;
    state.heap.peakBytes = Math.max(state.heap.peakBytes ?? heapBytes, heapBytes);
    state.heap.endBytes = heapBytes;
    state.heapStartBytes = state.heap.startBytes;
    state.heapPeakBytes = state.heap.peakBytes;
    state.heapEndBytes = state.heap.endBytes;
  }

  function setCurrent(key, value) {
    const normalized = Math.max(0, Number(value) || 0);
    state.current[key] = normalized;
    state.highWater[key] = Math.max(state.highWater[key] || 0, normalized);
  }

  function increment(key, value) {
    state.cumulative[key] = (state.cumulative[key] || 0) + Math.max(0, Number(value) || 0);
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
    setPcmQueue,
    recordPcmDrop,
    recordBlobQueued,
    recordBlobSettled,
    recordOpfsAppendStarted,
    recordOpfsAppendFinished,
    recordOpfsChunkReserved,
    recordOpfsChunkSealed,
    recordOpfsChunkDiscarded,
    setOpfsManifest,
    setLegacyQueue,
    recordLegacyRetry,
    setCollectionCounts,
    sample,
    complete,
    snapshot,
    exportJson,
    destroy
  });
}

function emptyState() {
  return {
    schemaVersion: RECORDING_DIAGNOSTIC_SCHEMA_VERSION,
    sampleIntervalMs: DEFAULT_SAMPLE_INTERVAL_MS,
    sampleCapacity: RECORDING_DIAGNOSTIC_SAMPLE_CAPACITY,
    samples: [],
    droppedSampleCount: 0,
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
    limits: { pcmPendingChunks: null, pcmPendingBytes: null },
    current: emptyMetrics(),
    cumulative: {},
    highWater: emptyMetrics(),
    latency: {
      opfsAppend: {
        window: 'recording_since_reset',
        method: 'fixed_histogram_upper_bound',
        count: 0,
        maxMs: 0,
        p95Status: 'unavailable',
        p95UpperBoundMs: null,
        p95LowerBoundMs: null,
        histogram: createLatencyHistogram()
      }
    },
    heap: { status: 'unavailable', startBytes: null, peakBytes: null, endBytes: null },
    heapStartBytes: null,
    heapPeakBytes: null,
    heapEndBytes: null
  };
}

function emptyMetrics() {
  return {
    pcmPendingChunks: 0,
    pcmPendingBytes: 0,
    blobBacklogCount: 0,
    blobBacklogBytes: 0,
    opfsPendingCount: 0,
    opfsPendingBytes: 0,
    opfsSealedBytes: 0,
    opfsUnsealedCount: 0,
    opfsUnsealedBytes: 0,
    legacyInputChunks: 0,
    legacyInputBytes: 0,
    cueCount: 0,
    snapshotCueCount: 0,
    replayEventCount: 0,
    diagnosticEntryCount: 0,
    diagnosticMapCount: 0
  };
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? Math.max(0, Number(value)) : null;
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
