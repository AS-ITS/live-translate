import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createRecordingDiagnostics,
  RECORDING_DIAGNOSTIC_SAMPLE_CAPACITY
} from '../../src/lib/recordingDiagnostics.js';

test('recording diagnostics tracks recorder, finalize, upload, and safe runtime metrics', () => {
  let currentTime = 0;
  let heapBytes = 100;
  let observerInstance;
  const timers = new Map();
  const diagnostics = createRecordingDiagnostics({
    now: () => currentTime,
    performanceImpl: { memory: { get usedJSHeapSize() { return heapBytes; } } },
    windowImpl: {
      setInterval(callback) {
        timers.set(1, callback);
        return 1;
      },
      clearInterval(id) {
        timers.delete(id);
      }
    },
    PerformanceObserverImpl: class {
      constructor(callback) {
        this.callback = callback;
        observerInstance = this;
      }

      observe() {}
      disconnect() {}
    }
  });

  diagnostics.reset({ mimeType: 'audio/webm;codecs=opus' });
  currentTime = 100;
  diagnostics.recordRecorderChunk({ size: 4, type: 'audio/webm;codecs=opus' });
  currentTime = 500;
  heapBytes = 250;
  diagnostics.recordRecorderChunk({ size: 6, type: 'audio/webm;codecs=opus' });
  diagnostics.beginFinalize();
  currentTime = 700;
  diagnostics.finishFinalize({ size: 10 });
  diagnostics.beginUpload({ byteSize: 10 });
  diagnostics.recordUploadProgress({ uploadedBytes: 7 });
  diagnostics.recordUploadRetry();
  currentTime = 900;
  diagnostics.completeUpload({ status: 'ready' });
  observerInstance.callback({ getEntries: () => [{ duration: 320 }] });

  const snapshot = diagnostics.snapshot();
  assert.equal(snapshot.mimeType, 'audio/webm;codecs=opus');
  assert.equal(snapshot.chunkCount, 2);
  assert.equal(snapshot.totalChunkBytes, 10);
  assert.equal(snapshot.maxChunkBytes, 6);
  assert.equal(snapshot.maxChunkCallbackGapMs, 400);
  assert.equal(snapshot.chunkCallbackGapCount, 1);
  assert.equal(snapshot.chunkCallbackGapP95Ms, 500);
  assert.equal(snapshot.finalizeDurationMs, 200);
  assert.equal(snapshot.finalizedBlobBytes, 10);
  assert.deepEqual(snapshot.upload, {
    status: 'ready',
    startedAt: 700,
    durationMs: 200,
    byteSize: 10,
    uploadedBytes: 7,
    retryCount: 1,
    errorCode: null
  });
  assert.equal(snapshot.longTaskCount, 1);
  assert.equal(snapshot.maxLongTaskMs, 320);
  assert.equal(snapshot.heapStartBytes, 100);
  assert.equal(snapshot.heapPeakBytes, 250);
  assert.equal(snapshot.heapEndBytes, 250);
  assert.equal(timers.size, 1);

  diagnostics.destroy();
  assert.equal(timers.size, 0);
});

test('recording diagnostics reports upload errors without retaining payloads', () => {
  const diagnostics = createRecordingDiagnostics({ enabled: true, now: () => 100 });
  diagnostics.reset({ mimeType: 'audio/webm' });
  diagnostics.beginUpload({ byteSize: 12 });
  diagnostics.failUpload({ errorCode: 'network_timeout' });

  const serialized = JSON.stringify(diagnostics.snapshot());
  assert.match(serialized, /network_timeout/);
  assert.doesNotMatch(serialized, /audio bytes|transcript|token|secret|signedURL/i);
});

test('recording diagnostics bounds samples and reports unavailable heap explicitly', () => {
  let currentTime = 0;
  const diagnostics = createRecordingDiagnostics({
    now: () => currentTime,
    performanceImpl: {},
    windowImpl: {}
  });
  diagnostics.reset();
  for (let index = 0; index < RECORDING_DIAGNOSTIC_SAMPLE_CAPACITY + 12; index += 1) {
    currentTime += 30_000;
    diagnostics.sample();
  }

  const snapshot = diagnostics.snapshot();
  assert.equal(snapshot.samples.length, RECORDING_DIAGNOSTIC_SAMPLE_CAPACITY);
  assert.equal(snapshot.droppedSampleCount, 13);
  assert.deepEqual(snapshot.heap, {
    status: 'unavailable',
    startBytes: null,
    peakBytes: null,
    endBytes: null
  });
});

test('recording diagnostics separates current, cumulative, high-water, and bounded latency statistics', () => {
  const diagnostics = createRecordingDiagnostics({ windowImpl: {} });
  diagnostics.reset();
  diagnostics.setPcmQueue({ chunks: 2, bytes: 640, maxChunks: 64, maxBytes: 480_000 });
  diagnostics.recordPcmDrop({ bytes: 320, durationMs: 10 });
  diagnostics.recordOpfsAppendStarted({ bytes: 100 });
  diagnostics.recordOpfsChunkReserved({ bytes: 100 });
  diagnostics.recordOpfsAppendFinished({ bytes: 100, durationMs: 73, status: 'failed', newlySealed: false });
  diagnostics.setPcmQueue({ chunks: 0, bytes: 0, maxChunks: 64, maxBytes: 480_000 });
  const sample = diagnostics.sample();

  assert.equal(sample.current.pcmPendingBytes, 0);
  assert.equal(sample.highWater.pcmPendingBytes, 640);
  assert.equal(sample.cumulative.pcmDroppedChunks, 1);
  assert.equal(sample.cumulative.pcmDroppedBytes, 320);
  assert.equal(sample.cumulative.opfsAppendFailures, 1);
  assert.equal(sample.latency.opfsAppend.window, 'recording_since_reset');
  assert.equal(sample.latency.opfsAppend.method, 'fixed_histogram_upper_bound');
  assert.equal(sample.latency.opfsAppend.maxMs, 73);
  assert.equal(sample.latency.opfsAppend.p95UpperBoundMs, 100);
  assert.equal(sample.latency.opfsAppend.p95Status, 'bounded');
});

test('recording diagnostics marks open-ended p95 bucket without claiming a false upper bound', () => {
  const diagnostics = createRecordingDiagnostics({ windowImpl: {} });
  diagnostics.reset();
  diagnostics.recordOpfsAppendStarted({ bytes: 1 });
  diagnostics.recordOpfsAppendFinished({ bytes: 1, durationMs: 4_500, status: 'failed' });
  const latency = diagnostics.snapshot().latency.opfsAppend;
  assert.equal(latency.p95Status, 'overflow_bucket');
  assert.equal(latency.p95UpperBoundMs, null);
  assert.equal(latency.p95LowerBoundMs, 3000);
  assert.equal(latency.maxMs, 4_500);
});

test('recording diagnostics reset prevents duplicate timers and complete is idempotent', () => {
  let nextTimer = 0;
  const timers = new Set();
  const diagnostics = createRecordingDiagnostics({
    performanceImpl: {},
    windowImpl: {
      setInterval() { nextTimer += 1; timers.add(nextTimer); return nextTimer; },
      clearInterval(id) { timers.delete(id); }
    }
  });
  diagnostics.reset();
  diagnostics.reset();
  assert.equal(timers.size, 1);
  diagnostics.complete();
  const sampleCount = diagnostics.snapshot().samples.length;
  diagnostics.complete();
  assert.equal(diagnostics.snapshot().samples.length, sampleCount);
  assert.equal(timers.size, 0);
});

test('recording diagnostics export includes schema, build, capabilities, and no payload content', () => {
  const diagnostics = createRecordingDiagnostics({
    now: () => 42,
    buildSha: 'abc123',
    navigatorImpl: { userAgent: 'Test Browser', storage: { getDirectory() {} } },
    performanceImpl: {},
    windowImpl: { MediaRecorder() {}, RTCPeerConnection() {}, AudioContext() {} }
  });
  diagnostics.reset({ mimeType: 'audio/webm;codecs=opus' });
  const exported = JSON.parse(diagnostics.exportJson());
  assert.equal(exported.schemaVersion, 'recording-diagnostics/v1');
  assert.equal(exported.buildSha, 'abc123');
  assert.equal(exported.browser.capabilities.opfs, true);
  assert.equal(exported.browser.capabilities.jsHeap, 'unavailable');
  assert.doesNotMatch(JSON.stringify(exported), /api[_-]?key|bearer|signed.?url|transcript/i);
});

test('recording diagnostics refreshes O(1) collection metadata at sample time and ignores provider failure', () => {
  let count = 3;
  const diagnostics = createRecordingDiagnostics({
    windowImpl: {},
    beforeSample: () => ({ diagnosticEntryCount: count })
  });
  diagnostics.reset();
  count = 7;
  assert.equal(diagnostics.sample().current.diagnosticEntryCount, 7);

  const resilient = createRecordingDiagnostics({
    windowImpl: {},
    beforeSample: () => { throw new Error('metadata unavailable'); }
  });
  assert.doesNotThrow(() => resilient.reset());
  assert.equal(resilient.sample().current.diagnosticEntryCount, 0);
});
