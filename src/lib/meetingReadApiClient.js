import { authenticatedFetch } from './accessToken.js';
import { meetingApiErrorMessage } from './meetingApiError.js';

export function meetingReadErrorMessage(error, fallback = '無法載入會議資料。') {
  return meetingApiErrorMessage(error, fallback);
}

export function createMeetingReadApiClient({ fetchImpl = globalThis.fetch, baseUrl = '' } = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('meeting read API client requires fetchImpl to be a function.');
  }
  fetchImpl = authenticatedFetch(fetchImpl);

  return {
    async listMeetingHistory() {
      const response = await fetchImpl(buildUrl(baseUrl, '/api/meetings'), { method: 'GET' });
      await assertOkResponse(response);
      const meetings = await parseJsonResponse(response);

      if (!Array.isArray(meetings)) {
        throw new Error('Meeting history response must be an array.');
      }

      return meetings;
    },

    async getMeetingDetail(meetingId) {
      const normalizedMeetingId = validateMeetingId(meetingId);
      const response = await fetchImpl(buildUrl(baseUrl, `/api/meetings/${encodeURIComponent(normalizedMeetingId)}`), {
        method: 'GET'
      });

      await assertOkResponse(response);
      const detail = await parseJsonResponse(response);

      if (!detail || typeof detail !== 'object' || Array.isArray(detail)) {
        throw new Error('Meeting detail response must be an object.');
      }

      return detail;
    }
  };
}

function buildUrl(baseUrl, path) {
  const normalizedBaseUrl = String(baseUrl || '').replace(/\/+$/, '');
  return normalizedBaseUrl ? `${normalizedBaseUrl}${path}` : path;
}

async function assertOkResponse(response) {
  if (!response || typeof response !== 'object') {
    throw new Error('Meeting read API request did not return a response.');
  }

  if (!response.ok) {
    const error = new Error(`Meeting read API request failed with HTTP ${response.status}.`);
    error.status = response.status;
    try {
      const body = typeof response.clone === 'function'
        ? await response.clone().json()
        : await response.json();
      error.code = body?.error?.code;
      error.apiMessage = body?.error?.message;
      error.requestId = body?.error?.requestId || body?.requestId;
    } catch {
      // Preserve the HTTP status when the error response is not JSON.
    }
    throw error;
  }
}

async function parseJsonResponse(response) {
  if (typeof response?.json !== 'function') {
    throw new Error('Meeting read API response cannot be parsed as JSON.');
  }

  try {
    return await response.json();
  } catch (error) {
    throw new Error('Meeting read API response must be valid JSON.', { cause: error });
  }
}

function validateMeetingId(meetingId) {
  if (typeof meetingId !== 'string' || meetingId.trim() === '') {
    throw new TypeError('meetingId must be a non-empty string.');
  }

  return meetingId;
}
