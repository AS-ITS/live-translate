import { meetingLifecycleWriteHeaders } from './meetingLifecycleWriteFence.js';
import { fetchWithTimeout } from './requestTimeout.js';

export function createMeetingCueApiClient({ fetchImpl = globalThis.fetch, baseUrl = '', requestTimeoutMs = 5_000, timeoutOptions = {} } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('meeting cue API client requires fetchImpl to be a function.');

  return Object.freeze({
    async publish({ meetingId, segmentId, sessionId, cue, producedAt = null, headers = {} } = {}) {
      if (!meetingId || !segmentId || !sessionId || !cue) throw new TypeError('meetingId, segmentId, sessionId, and cue are required.');
      const response = await fetchWithTimeout(fetchImpl, buildUrl(baseUrl, `/api/meetings/${encodeURIComponent(meetingId)}/segments/${encodeURIComponent(segmentId)}/cues`), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...headers,
          ...meetingLifecycleWriteHeaders(meetingId, segmentId)
        },
        body: JSON.stringify({ sessionId, cue, producedAt })
      }, { timeoutMs: requestTimeoutMs, operation: 'publish-cue', ...timeoutOptions });
      if (!response?.ok) {
        const error = new Error(`Meeting cue publish failed with HTTP ${response?.status}.`);
        const status = Number(response?.status);
        if (Number.isInteger(status) && status >= 100 && status <= 599) {
          error.status = status;
        }
        try {
          const body = await response.json();
          const bodyError = body?.error || body;
          if (typeof bodyError?.code === 'string' && /^[a-z0-9][a-z0-9_:-]*$/iu.test(bodyError.code)) {
            error.code = bodyError.code;
          }
          if (typeof bodyError?.requestId === 'string' && bodyError.requestId.trim() !== '') {
            error.requestId = bodyError.requestId;
          }
        } catch {
          // Keep status as the stable safe diagnostic when the body is unavailable.
        }
        throw error;
      }
      return response.json();
    }
  });
}

function buildUrl(baseUrl, path) {
  const normalizedBaseUrl = String(baseUrl || '').replace(/\/+$/, '');
  return normalizedBaseUrl ? `${normalizedBaseUrl}${path}` : path;
}
