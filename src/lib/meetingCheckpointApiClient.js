export function createMeetingCheckpointApiClient({ fetchImpl = globalThis.fetch, baseUrl = '' } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('meeting checkpoint API client requires fetchImpl to be a function.');

  return Object.freeze({
    async createMeeting() {
      const response = await fetchImpl(buildUrl(baseUrl, '/api/meetings'), { method: 'POST' });
      await assertOkResponse(response);
      return parseCreateMeetingResponse(response);
    },

    async updateCheckpoint({ meetingId, segmentId, idempotencyKey, durableChunks } = {}) {
      assertNonEmptyString(meetingId, 'meetingId');
      assertNonEmptyString(segmentId, 'segmentId');
      assertNonEmptyString(idempotencyKey, 'idempotencyKey');
      if (!Array.isArray(durableChunks)) throw new TypeError('durableChunks must be an array.');

      const response = await fetchImpl(buildUrl(
        baseUrl,
        `/api/meetings/${encodeURIComponent(meetingId)}/segments/${encodeURIComponent(segmentId)}/checkpoint`
      ), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idempotencyKey,
          durableChunks,
          pendingPartial: null
        })
      });
      await assertOkResponse(response);
      return parseCheckpointResponse(response);
    }
  });
}

function buildUrl(baseUrl, path) {
  const normalizedBaseUrl = String(baseUrl || '').replace(/\/+$/, '');
  return normalizedBaseUrl ? `${normalizedBaseUrl}${path}` : path;
}

async function assertOkResponse(response) {
  if (!response || typeof response !== 'object') throw new Error('Meeting checkpoint API request did not return a response.');
  if (!response.ok) throw new Error(`Meeting checkpoint API request failed with HTTP ${response.status}.`);
}

async function parseCreateMeetingResponse(response) {
  const body = await parseJsonResponse(response);
  const meeting = body?.meeting;
  const segment = body?.segment;
  if (!meeting || typeof meeting.id !== 'string' || !segment || typeof segment.id !== 'string') {
    throw new Error('Create meeting response must contain meeting.id and segment.id.');
  }
  return body;
}

async function parseCheckpointResponse(response) {
  const body = await parseJsonResponse(response);
  if (!body || typeof body !== 'object' || !body.checkpoint || !Array.isArray(body.checkpoint.durableChunks)) {
    throw new Error('Checkpoint response must contain checkpoint.durableChunks.');
  }
  return body;
}

async function parseJsonResponse(response) {
  if (typeof response?.json !== 'function') throw new Error('Meeting checkpoint API response cannot be parsed as JSON.');
  return response.json();
}

function assertNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string.`);
  }
}
