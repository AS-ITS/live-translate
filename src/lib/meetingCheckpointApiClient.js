import { authenticatedFetch } from './accessToken.js';

export function createMeetingCheckpointApiClient({ fetchImpl = globalThis.fetch, baseUrl = '', authorizationHeaders = {} } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('meeting checkpoint API client requires fetchImpl to be a function.');
  fetchImpl = authenticatedFetch(fetchImpl);

  return Object.freeze({
    async createMeeting(input = {}) {
      const { liveSessionId, glossaryEntries = [], privateGlossaryEntries = [], name, sourceLanguageCode, targetLanguageCode, draft = false } = input;
      const options = { method: 'POST' };
      if ((liveSessionId !== undefined && liveSessionId !== null) || Object.hasOwn(input, 'glossaryEntries') || Object.hasOwn(input, 'privateGlossaryEntries')) {
        assertNonEmptyString(liveSessionId, 'liveSessionId');
        if (!Array.isArray(glossaryEntries)) throw new TypeError('glossaryEntries must be an array.');
        if (!Array.isArray(privateGlossaryEntries)) throw new TypeError('privateGlossaryEntries must be an array.');
        options.headers = { 'Content-Type': 'application/json' };
        options.body = JSON.stringify({
          ...(liveSessionId === undefined ? {} : { liveSessionId }),
          ...(Object.hasOwn(input, 'glossaryEntries') ? { glossaryEntries } : {}),
          ...(Object.hasOwn(input, 'privateGlossaryEntries') ? { privateGlossaryEntries } : {}),
          ...(name !== undefined ? { name } : {}),
          ...(sourceLanguageCode !== undefined ? { sourceLanguageCode } : {}),
          ...(targetLanguageCode !== undefined ? { targetLanguageCode } : {}),
          ...(draft ? { draft: true } : {})
        });
      }

      options.headers = { ...authorizationHeadersFor(authorizationHeaders), ...(options.headers || {}) };
      const response = await fetchImpl(buildUrl(baseUrl, '/api/meetings'), options);
      await assertOkResponse(response);
      return parseCreateMeetingResponse(response);
    },

    async listSegments({ meetingId } = {}) {
      assertNonEmptyString(meetingId, 'meetingId');
      const response = await fetchImpl(buildUrl(
        baseUrl,
        `/api/meetings/${encodeURIComponent(meetingId)}/segments`
      ), { method: 'GET' });
      await assertOkResponse(response);
      return parseSegmentsResponse(response);
    },

    async completeMeeting({ meetingId } = {}) {
      assertNonEmptyString(meetingId, 'meetingId');
      const response = await fetchImpl(buildUrl(
        baseUrl,
        `/api/meetings/${encodeURIComponent(meetingId)}/complete`
      ), {
        method: 'POST',
        headers: authorizationHeadersFor(authorizationHeaders)
      });
      await assertOkResponse(response);
      const body = await response.json();
      return { meeting: body?.meeting || body };
    },

    async startMeeting({ meetingId, segmentId, liveSessionId } = {}) {
      assertNonEmptyString(meetingId, 'meetingId');
      assertNonEmptyString(segmentId, 'segmentId');
      assertNonEmptyString(liveSessionId, 'liveSessionId');
      const response = await fetchImpl(buildUrl(baseUrl, `/api/meetings/${encodeURIComponent(meetingId)}/segments/${encodeURIComponent(segmentId)}/start`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authorizationHeadersFor(authorizationHeaders) },
        body: JSON.stringify({ liveSessionId })
      });
      try {
        await assertOkResponse(response);
      } catch (error) {
        error.endpoint = `/api/meetings/${encodeURIComponent(meetingId)}/segments/${encodeURIComponent(segmentId)}/start`;
        error.meetingId = meetingId;
        error.segmentId = segmentId;
        error.liveSessionId = liveSessionId;
        if (import.meta.env?.DEV) {
          console.error('[meeting-start-failed]', {
            status: error.status,
            code: error.code,
            requestId: error.requestId,
            endpoint: error.endpoint,
            meetingId,
            segmentId,
            liveSessionId,
            responseBody: error.responseBody
          });
        }
        throw error;
      }
      return parseStartMeetingResponse(response);
    },

    async getCheckpoint({ meetingId, segmentId } = {}) {
      assertNonEmptyString(meetingId, 'meetingId');
      assertNonEmptyString(segmentId, 'segmentId');
      const url = buildUrl(
        baseUrl,
        `/api/meetings/${encodeURIComponent(meetingId)}/segments/${encodeURIComponent(segmentId)}/checkpoint`
      );
      const options = {
        method: 'GET',
        headers: { Accept: 'application/json', ...authorizationHeadersFor(authorizationHeaders) }
      };
      if (import.meta.env?.DEV) {
        console.debug('[resume-checkpoint]', {
          meetingId,
          segmentId,
          method: options.method,
          url,
          hasBody: Object.hasOwn(options, 'body')
        });
      }
      const response = await fetchImpl(url, options);
      await assertOkResponse(response);
      return parseCheckpointResponse(response);
    },

    async updateCheckpoint(input = {}) {
      const { meetingId, segmentId, idempotencyKey, durableChunks, refinedSubtitleCues, refinedSubtitleRevision, refinedSubtitleInputHash, refinedSubtitleStatus } = input;
      assertNonEmptyString(meetingId, 'meetingId');
      assertNonEmptyString(segmentId, 'segmentId');
      assertNonEmptyString(idempotencyKey, 'idempotencyKey');
      if (!Array.isArray(durableChunks)) throw new TypeError('durableChunks must be an array.');

      const body = { idempotencyKey, durableChunks, pendingPartial: null };
      if (Object.hasOwn(input, 'finalCues')) body.finalCues = input.finalCues;
      for (const [field, value] of Object.entries({ refinedSubtitleCues, refinedSubtitleRevision, refinedSubtitleInputHash, refinedSubtitleStatus })) {
        if (value !== undefined) body[field] = value;
      }
      for (const field of ['refinedSubtitleCues', 'refinedSubtitleRevision', 'refinedSubtitleInputHash', 'refinedSubtitleStatus']) {
        if (Object.hasOwn(input, field)) body[field] = input[field];
      }
      if (Object.hasOwn(input, 'cueCheckpoint')) body.cueCheckpoint = input.cueCheckpoint;
      const response = await fetchImpl(buildUrl(
        baseUrl,
        `/api/meetings/${encodeURIComponent(meetingId)}/segments/${encodeURIComponent(segmentId)}/checkpoint`
      ), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authorizationHeadersFor(authorizationHeaders) },
        body: JSON.stringify({
          ...body
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
        headers: { 'Content-Type': 'application/json', ...authorizationHeadersFor(authorizationHeaders) },
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
      if (outcome === 'interrupted' && nextLiveSessionId !== null && nextLiveSessionId !== undefined) {
        assertNonEmptyString(nextLiveSessionId, 'nextLiveSessionId');
      } else if (outcome === 'failed') {
        assertNonEmptyString(nextLiveSessionId, 'nextLiveSessionId');
      }
      assertNonEmptyString(failureReason, 'failureReason');
      assertNonEmptyString(failureCategory, 'failureCategory');
      if (outcome !== 'interrupted' && outcome !== 'failed') throw new TypeError('outcome must be interrupted or failed.');
      if (!checkpoint || typeof checkpoint !== 'object') throw new TypeError('checkpoint must be an object.');

      const response = await fetchImpl(buildUrl(
        baseUrl,
        `/api/meetings/${encodeURIComponent(meetingId)}/segments/${encodeURIComponent(segmentId)}/recover`
      ), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authorizationHeadersFor(authorizationHeaders) },
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

function authorizationHeadersFor(value) {
  return typeof value === 'function' ? (value() || {}) : (value || {});
}

async function assertOkResponse(response) {
  if (!response || typeof response !== 'object') throw new Error('Meeting checkpoint API request did not return a response.');
  if (response.ok) return;

  let body = null;
  try {
    body = await response.json();
  } catch {
    // Keep the HTTP status when the server response is not JSON.
  }

  const error = new Error(`Meeting checkpoint API request failed with HTTP ${response.status}.`);
  error.status = response.status;
  error.code = body?.error?.code || body?.code;
  error.apiMessage = typeof body?.error?.message === 'string'
    ? body.error.message
    : typeof body?.message === 'string'
      ? body.message
      : null;
  error.details = Array.isArray(body?.error?.details) ? body.error.details : [];
  error.requestId = response.headers?.get?.('x-request-id') || body?.requestId || body?.error?.requestId;
  error.responseBody = body && typeof body === 'object' ? {
    error: body.error && typeof body.error === 'object' ? {
      ...(typeof body.error.code === 'string' ? { code: body.error.code } : {}),
      ...(typeof body.error.message === 'string' ? { message: body.error.message } : {}),
      ...(typeof body.error.requestId === 'string' ? { requestId: body.error.requestId } : {}),
      ...(Array.isArray(body.error.details) ? { details: body.error.details } : {})
    } : undefined
  } : null;
  if (!error.responseBody?.error) error.responseBody = null;
  throw error;
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

async function parseSegmentsResponse(response) {
  const body = await parseJsonResponse(response);
  if (!body || typeof body !== 'object' || typeof body.meetingId !== 'string' || !Array.isArray(body.segments)) {
    throw new Error('Segments response must contain meetingId and segments.');
  }
  return body;
}

async function parseStartMeetingResponse(response) {
  const body = await parseJsonResponse(response);
  if (!body?.meeting?.id || !body?.segment?.id) throw new Error('Start meeting response must contain meeting and segment.');
  return body;
}

async function parseCheckpointResponse(response) {
  const body = await parseJsonResponse(response);
  if (!body || typeof body !== 'object' || (body.checkpoint !== null && (!body.checkpoint || !Array.isArray(body.checkpoint.durableChunks)))) {
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
