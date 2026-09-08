import { createAudioUploadController } from '../../lib/audioUploadController.js';

export function createAudioUploadSegmentState(now = () => Date.now()) {
  return {
    input: { nextIndex: 0, lastFlushedAt: now(), inFlight: false, currentPromise: null },
    translation: { nextIndex: 0, lastFlushedAt: now(), inFlight: false, currentPromise: null }
  };
}

/**
 * Binds the browser-facing Live workflow to the reusable audio upload
 * controller. The React application supplies refs and error presentation;
 * upload sequencing and retry state stay inside the feature boundary.
 */
export function createLiveAudioBindings({
  chunks,
  metadata,
  segments,
  retryTimers,
  retryAttempts,
  getActiveSessionId,
  setError
}) {
  const controller = createAudioUploadController({
    chunks,
    metadata,
    segments,
    retryTimers,
    retryAttempts,
    getActiveSessionId,
    setError
  });

  return {
    flushAudioSegmentIfDue: (kind) => controller.flushIfDue(kind),
    flushAudioSegment: (kind, options) => controller.flush(kind, options),
    resetAudioUploadSegment: (kind) => controller.resetSegment(kind),
    audioUploadSessionId: (kind) => controller.sessionIdFor(kind),
    scheduleAudioUploadRetry: (kind, sessionId) => controller.scheduleRetry(kind, sessionId),
    clearAudioUploadRetry: (kind) => controller.clearRetry(kind),
    cancelAudioUploadRetries: () => controller.cancelRetries(),
    isRetryableAudioUploadError: (error) => controller.isRetryableError(error),
    uploadSessionAudioSegment: (sessionId, kind, options) => controller.uploadSegment(sessionId, kind, options)
  };
}
