import assert from 'node:assert/strict';
import test from 'node:test';
import { createRecordingDiagnostics } from '../../src/lib/recordingDiagnostics.js';

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
