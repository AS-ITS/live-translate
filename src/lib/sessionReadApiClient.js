export function createSessionReadApiClient({ fetchImpl = globalThis.fetch, baseUrl = '' } = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('session read API client requires fetchImpl to be a function.');
  }

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

    async getSessionSummary(sessionId) {
      const normalizedSessionId = validateSessionId(sessionId);
      const response = await fetchImpl(buildUrl(baseUrl, `/api/sessions/${encodeURIComponent(normalizedSessionId)}/summary`), {
        method: 'GET'
      });

      if (response?.status === 404) {
        const body = await parseJsonResponse(response);

        if (body?.error?.code === 'meeting_summary_not_found') {
          return null;
        }

        throw new Error('Session summary request failed with HTTP 404.');
      }

      await assertOkResponse(response);

      const summary = await parseJsonResponse(response);

      if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
        throw new Error('Session summary response must be an object.');
      }

      return summary;
    },

    async retrySessionSummary(sessionId) {
      const normalizedSessionId = validateSessionId(sessionId);
      const response = await fetchImpl(buildUrl(baseUrl, `/api/sessions/${encodeURIComponent(normalizedSessionId)}/summary/retry`), { method: 'POST' });
      await assertOkResponse(response);
      return parseJsonResponse(response);
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

function buildUrl(baseUrl, path) {
  const normalizedBaseUrl = String(baseUrl || '').replace(/\/+$/, '');

  return normalizedBaseUrl ? `${normalizedBaseUrl}${path}` : path;
}

async function assertOkResponse(response) {
  if (!response || typeof response !== 'object') {
    throw new Error('Session read API request did not return a response.');
  }

  if (!response.ok) {
    throw new Error(`Session read API request failed with HTTP ${response.status}.`);
  }
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
