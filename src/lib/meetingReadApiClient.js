import { authenticatedFetch } from './accessToken.js';

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

      if (response?.status === 404) {
        const body = await parseJsonResponse(response);
        if (body?.error?.code === 'meeting_not_found') {
          return null;
        }

        throw new Error('Meeting detail request failed with HTTP 404.');
      }

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
    throw new Error(`Meeting read API request failed with HTTP ${response.status}.`);
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
