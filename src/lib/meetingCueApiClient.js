export function createMeetingCueApiClient({ fetchImpl = globalThis.fetch, baseUrl = '' } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('meeting cue API client requires fetchImpl to be a function.');

  return Object.freeze({
    async publish({ meetingId, segmentId, sessionId, cue, producedAt = null, headers = {} } = {}) {
      if (!meetingId || !segmentId || !sessionId || !cue) throw new TypeError('meetingId, segmentId, sessionId, and cue are required.');
      const response = await fetchImpl(buildUrl(baseUrl, `/api/meetings/${encodeURIComponent(meetingId)}/segments/${encodeURIComponent(segmentId)}/cues`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ sessionId, cue, producedAt })
      });
      if (!response?.ok) {
        const error = new Error(`Meeting cue publish failed with HTTP ${response?.status}.`);
        error.status = response?.status;
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
