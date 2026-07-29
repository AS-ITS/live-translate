export function createMeetingCheckpointApiClient({ fetchImpl = globalThis.fetch, baseUrl = '' } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('meeting checkpoint API client requires fetchImpl to be a function.');

  return Object.freeze({
    async createMeeting({ liveSessionId } = {}) {
      const options = { method: 'POST' };
      if (liveSessionId !== undefined && liveSessionId !== null) {
        assertNonEmptyString(liveSessionId, 'liveSessionId');
        options.headers = { 'Content-Type': 'application/json' };
        options.body = JSON.stringify({ liveSessionId });
      }

      const response = await fetchImpl(buildUrl(baseUrl, '/api/meetings'), options);
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
    },

    async rolloverSegment({ meetingId, segmentId, idempotencyKey, checkpoint, nextLiveSessionId } = {}) {
      assertNonEmptyString(meetingId, 'meetingId');
      assertNonEmptyString(segmentId, 'segmentId');
      assertNonEmptyString(idempotencyKey, 'idempotencyKey');
      assertNonEmptyString(nextLiveSessionId, 'nextLiveSessionId');
      if (!checkpoint || typeof checkpoint !== 'object') throw new TypeError('checkpoint must be an object.');

      const response = await fetchImpl(buildUrl(
        baseUrl,
        `/api/meetings/${encodeURIComponent(meetingId)}/segments/${encodeURIComponent(segmentId)}/rollover`
      ), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idempotencyKey,
          checkpoint,
          nextLiveSessionId
        })
      });
      await assertOkResponse(response);
      return parseRolloverResponse(response);
    },

    async recoverSegment({
      meetingId,
      segmentId,
      idempotencyKey,
      checkpoint,
      nextLiveSessionId,
      failureReason,
      failureCategory,
      outcome
    } = {}) {
      assertNonEmptyString(meetingId, 'meetingId');
      assertNonEmptyString(segmentId, 'segmentId');
      assertNonEmptyString(idempotencyKey, 'idempotencyKey');
      assertNonEmptyString(nextLiveSessionId, 'nextLiveSessionId');
      assertNonEmptyString(failureReason, 'failureReason');
      assertNonEmptyString(failureCategory, 'failureCategory');
      if (outcome !== 'interrupted' && outcome !== 'failed') throw new TypeError('outcome must be interrupted or failed.');
      if (!checkpoint || typeof checkpoint !== 'object') throw new TypeError('checkpoint must be an object.');

      const response = await fetchImpl(buildUrl(
        baseUrl,
        `/api/meetings/${encodeURIComponent(meetingId)}/segments/${encodeURIComponent(segmentId)}/recover`
      ), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idempotencyKey,
          checkpoint,
          nextLiveSessionId,
          failureReason,
          failureCategory,
          outcome
        })
      });
      await assertOkResponse(response);
      return parseRecoverResponse(response);
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

async function parseRolloverResponse(response) {
  const body = await parseJsonResponse(response);
  if (!body || typeof body !== 'object' || !body.completedSegment || !body.segment || typeof body.segment.id !== 'string') {
    throw new Error('Rollover response must contain completedSegment and segment.id.');
  }
  return body;
}

async function parseRecoverResponse(response) {
  const body = await parseJsonResponse(response);
  if (!body || typeof body !== 'object') {
    throw new Error('Recover response must be an object.');
  }
  if (body.outcome === 'failed' || body.failedSegment) {
    if (!body.failedSegment || typeof body.failedSegment.id !== 'string') {
      throw new Error('Recover failed response must contain failedSegment.id.');
    }
    return body;
  }
  if (!body.interruptedSegment || !body.segment || typeof body.segment.id !== 'string') {
    throw new Error('Recover interrupted response must contain interruptedSegment and segment.id.');
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
