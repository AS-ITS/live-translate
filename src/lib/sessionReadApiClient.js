import { authenticatedFetch } from './accessToken.js';
import { mergeRetranslationHistoryIntoDetail } from './sessionTranslationHistory.js';

export function createSessionReadApiClient({ fetchImpl = globalThis.fetch, baseUrl = '' } = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('session read API client requires fetchImpl to be a function.');
  }
  fetchImpl = authenticatedFetch(fetchImpl);

  return {
    async listSessionHistory() {
      const response = await fetchImpl(buildUrl(baseUrl, '/api/sessions'), {
        method: 'GET'
      });

      await assertOkResponse(response);

      const history = await parseJsonResponse(response);

      if (!Array.isArray(history)) {
        throw new Error('Session history response must be an array.');
      }

      return history;
    },

    async getSessionDetail(sessionId) {
      const normalizedSessionId = validateSessionId(sessionId);
      const response = await fetchImpl(buildUrl(baseUrl, `/api/sessions/${encodeURIComponent(normalizedSessionId)}`), {
        method: 'GET'
      });

      if (response?.status === 404) {
        const body = await parseJsonResponse(response);

        if (body?.error?.code === 'session_not_found') {
          return null;
        }

        throw new Error('Session detail request failed with HTTP 404.');
      }

      await assertOkResponse(response);

      const detail = await parseJsonResponse(response);

      if (!detail || typeof detail !== 'object' || Array.isArray(detail)) {
        throw new Error('Session detail response must be an object.');
      }

      return detail;
    },

    async deleteSessionRecord(sessionId) {
      const normalizedSessionId = validateSessionId(sessionId);
      const response = await fetchImpl(buildUrl(baseUrl, `/api/sessions/${encodeURIComponent(normalizedSessionId)}`), {
        method: 'DELETE'
      });

      if (response?.status === 404) {
        const body = await parseJsonResponse(response);

        if (body?.error?.code === 'session_not_found') {
          return null;
        }

        throw new Error('Session delete request failed with HTTP 404.');
      }

      await assertOkResponse(response);

      const result = await parseJsonResponse(response);

      if (!result || typeof result !== 'object' || Array.isArray(result) || result.deleted !== true) {
        throw new Error('Session delete response must confirm deletion.');
      }

      return result;
    },

    async getSessionTranslations(sessionId, { targetLanguageCode } = {}) {
      const normalizedSessionId = validateSessionId(sessionId);
      const query = targetLanguageCode === undefined ? '' : `?targetLanguageCode=${encodeURIComponent(targetLanguageCode)}`;
      const response = await fetchImpl(buildUrl(baseUrl, `/api/sessions/${encodeURIComponent(normalizedSessionId)}/translations${query}`), { method: 'GET' });
      if (response?.status === 404) return null;
      await assertOkResponse(response);
      const history = await parseJsonResponse(response);
      if (!history || typeof history !== 'object' || Array.isArray(history) || !Array.isArray(history.translations)) {
        throw new Error('Session translation history response must be an object.');
      }
      return history;
    },

    async deleteSessionTranslationOutput(sessionId, outputId) {
      const normalizedSessionId = validateSessionId(sessionId);
      const normalizedOutputId = validateOutputId(outputId);
      const response = await fetchImpl(
        buildUrl(baseUrl, `/api/sessions/${encodeURIComponent(normalizedSessionId)}/translations/${encodeURIComponent(normalizedOutputId)}`),
        { method: 'DELETE' }
      );

      if (response?.status === 404) {
        return null;
      }

      await assertOkResponse(response);

      const result = await parseJsonResponse(response);

      if (!result || typeof result !== 'object' || Array.isArray(result) || result.deleted !== true) {
        throw new Error('Session translation output delete response must confirm deletion.');
      }

      return result;
    }
  };
}

export async function readSessionDetailWithTranslationHistory({ apiClient, sessionId } = {}) {
  if (!apiClient || typeof apiClient.getSessionDetail !== 'function' || typeof apiClient.getSessionTranslations !== 'function') {
    throw new TypeError('session read API client must expose detail and translation history readers.');
  }

  const [sessionDetailResult, translationHistoryResult] = await Promise.allSettled([
    apiClient.getSessionDetail(sessionId),
    apiClient.getSessionTranslations(sessionId)
  ]);
  const detailError = sessionDetailResult.status === 'rejected' ? sessionDetailResult.reason : null;
  const translationError = translationHistoryResult.status === 'rejected' ? translationHistoryResult.reason : null;

  if (detailError && !isSessionReadCloudUnavailable(detailError)) throw detailError;
  if (translationError && !isSessionReadCloudUnavailable(translationError) && !sessionDetailResult.value) {
    throw translationError;
  }
  if (isSessionReadCloudUnavailable(detailError) && isSessionReadCloudUnavailable(translationError)) {
    throw detailError;
  }

  return mergeRetranslationHistoryIntoDetail(
    sessionDetailResult.status === 'fulfilled' ? sessionDetailResult.value : null,
    translationHistoryResult.status === 'fulfilled' ? translationHistoryResult.value : null
  );
}

function buildUrl(baseUrl, path) {
  const normalizedBaseUrl = String(baseUrl || '').replace(/\/+$/, '');

  return normalizedBaseUrl ? `${normalizedBaseUrl}${path}` : path;
}

async function assertOkResponse(response) {
  if (!response || typeof response !== 'object') {
    throw new Error('Session read API request did not return a response.');
  }

  if (response.ok) return;

  let body = null;
  try {
    body = await parseJsonResponse(response);
  } catch {
    // The status remains the authoritative safe diagnostic when the body is not JSON.
  }

  const error = new Error(body?.error?.message || `Session read API request failed with HTTP ${response.status}.`);
  const status = Number(response.status);
  if (Number.isInteger(status) && status >= 100 && status <= 599) error.status = status;
  const code = body?.error?.code || body?.code;
  if (typeof code === 'string' && /^[a-z0-9][a-z0-9_:-]*$/iu.test(code)) error.code = code;
  const requestId = body?.error?.requestId || body?.requestId || response.headers?.get?.('x-request-id');
  if (typeof requestId === 'string' && requestId.trim() !== '') error.requestId = requestId;
  throw error;
}

export function isSessionReadCloudUnavailable(error) {
  return error?.status === 410 || error?.status === 503 || error?.code === 'cloud_capability_unavailable'
    || error?.code === 'supabase_unavailable' || error?.code === 'supabase_request_failed';
}

async function parseJsonResponse(response) {
  if (typeof response?.json !== 'function') {
    throw new Error('Session read API response cannot be parsed as JSON.');
  }

  try {
    return await response.json();
  } catch (error) {
    throw new Error('Session read API response must be valid JSON.', { cause: error });
  }
}

function validateSessionId(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    throw new TypeError('sessionId must be a non-empty string.');
  }

  return sessionId;
}

function validateOutputId(outputId) {
  if (typeof outputId !== 'string' || outputId.trim() === '') {
    throw new TypeError('outputId must be a non-empty string.');
  }

  return outputId;
}
