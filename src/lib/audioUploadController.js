import { authenticatedFetch } from './accessToken.js';
import {
  INPUT_SAMPLE_RATE,
  buildInputAudioFileName,
  buildTranslatedAudioFileName,
  pcm16ChunksToWavBlob
} from './audio.js';

const DEFAULT_SEGMENT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_RETRY_DELAY_MS = 5000;
const DEFAULT_MAX_RETRY_DELAY_MS = 60000;
const MAX_INPUT_UPLOAD_BUFFERED_BYTES = 16 * 1024 * 1024;

export function createAudioUploadController({
  chunks,
  metadata,
  segments,
  retryTimers,
  retryAttempts,
  getActiveSessionId,
  setError,
  fetchImpl = fetch,
  now = () => Date.now(),
  windowImpl = typeof window === 'undefined' ? globalThis : window,
  segmentIntervalMs = DEFAULT_SEGMENT_INTERVAL_MS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  maxRetryDelayMs = DEFAULT_MAX_RETRY_DELAY_MS,
  maxInputBufferedBytes = MAX_INPUT_UPLOAD_BUFFERED_BYTES
}) {
  function clearRetry(kind) {
    const timer = retryTimers.current[kind];
    if (timer) windowImpl.clearTimeout(timer);
    retryTimers.current[kind] = null;
    retryAttempts.current[kind] = 0;
  }

  function resetSegment(kind) {
    clearRetry(kind);
    segments.current[kind] = { nextIndex: 0, lastFlushedAt: now(), inFlight: false, currentPromise: null };
  }

  function sessionIdFor(kind) {
    return metadata[kind].current.sessionId || getActiveSessionId();
  }

  function isRetryableError(error) {
    const status = Number(error?.status);
    if (status === 404 || status === 409 || status === 413) return false;
    return !Number.isFinite(status) || status === 408 || status === 425 || status === 429 || status >= 500;
  }

  async function uploadSegment(sessionId, kind, { blob, segmentIndex, fileName }) {
    const response = await authenticatedFetch(fetchImpl)(`/api/sessions/${encodeURIComponent(sessionId)}/audio/${kind}/segments/${segmentIndex}`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav', 'X-File-Name': fileName || '' },
      body: blob
    });
    if (!response.ok) {
      const error = new Error(`Session audio segment upload failed with HTTP ${response.status}.`);
      error.status = response.status;
      throw error;
    }
  }

  function scheduleRetry(kind, sessionId) {
    if (!sessionId || retryTimers.current[kind]) return;
    const attempt = retryAttempts.current[kind] + 1;
    retryAttempts.current[kind] = attempt;
    const delay = Math.min(retryDelayMs * (2 ** Math.max(0, attempt - 1)), maxRetryDelayMs);
    retryTimers.current[kind] = windowImpl.setTimeout(() => {
      retryTimers.current[kind] = null;
      void flush(kind, { force: true, sessionId }).catch(() => {});
    }, delay);
  }

  async function flush(kind, { force = false, sessionId = getActiveSessionId() } = {}) {
    const chunksRef = chunks[kind];
    const metadataRef = metadata[kind].current;
    const segment = segments.current[kind];
    if (!sessionId) return null;
    if (segment.inFlight) {
      if (!force) return null;
      await segment.currentPromise?.catch(() => {});
    }
    if (chunksRef.current.length === 0) return null;
    if (!force && now() - segment.lastFlushedAt < segmentIntervalMs) return null;

    const uploadChunks = chunksRef.current.slice();
    chunksRef.current = [];
    segment.inFlight = true;
    const uploadPromise = (async () => {
      const blob = pcm16ChunksToWavBlob(uploadChunks, {
        sampleRate: kind === 'input' ? INPUT_SAMPLE_RATE : undefined,
        normalizePeak: true
      });
      await uploadSegment(sessionId, kind, {
        blob,
        segmentIndex: segment.nextIndex,
        fileName: kind === 'input'
          ? buildInputAudioFileName(metadataRef)
          : buildTranslatedAudioFileName({ sessionId: metadataRef.sessionId || sessionId, startedAt: metadataRef.startedAt })
      });
      segment.nextIndex += 1;
      segment.lastFlushedAt = now();
      clearRetry(kind);
      setError((current) => current.startsWith('語音紀錄暫時無法同步') ? '' : current);
      return true;
    })();
    segment.currentPromise = uploadPromise;
    try {
      return await uploadPromise;
    } catch (error) {
      const restored = uploadChunks.concat(chunksRef.current);
      if (kind === 'input') {
        let byteCount = 0;
        let keepCount = 0;
        while (keepCount < restored.length
          && byteCount + restored[keepCount].byteLength <= maxInputBufferedBytes) {
          byteCount += restored[keepCount].byteLength;
          keepCount += 1;
        }
        chunksRef.current = restored.slice(0, keepCount);
        if (keepCount < restored.length) {
          setError('原始音訊上傳緩衝超過 16 MiB，部分上傳資料已捨棄；請核對 PCM Journal。');
        }
      } else chunksRef.current = restored;
      if (isRetryableError(error)) scheduleRetry(kind, sessionId);
      throw error;
    } finally {
      segment.inFlight = false;
      if (segment.currentPromise === uploadPromise) segment.currentPromise = null;
    }
  }

  async function flushIfDue(kind) {
    try { await flush(kind); } catch { /* retry timer owns recovery */ }
  }

  function cancelRetries() {
    clearRetry('input');
    clearRetry('translation');
  }

  return Object.freeze({ clearRetry, resetSegment, sessionIdFor, isRetryableError, uploadSegment, scheduleRetry, flush, flushIfDue, cancelRetries });
}
