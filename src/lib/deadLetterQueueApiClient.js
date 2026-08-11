import { authenticatedFetch } from './accessToken.js';

export function createDeadLetterQueueApiClient({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('dead-letter queue API client requires fetchImpl to be a function.');
  fetchImpl = authenticatedFetch(fetchImpl);

  return Object.freeze({
    async list() {
      const payload = await request('/api/translation-dead-letter-queue', { method: 'GET' });
      if (!payload || typeof payload !== 'object' || !Array.isArray(payload.items) || !Number.isInteger(payload.size)) {
        throw new Error('Dead-letter queue response must contain items and size.');
      }
      return payload;
    },

    async replay(executionId) {
      if (!nonEmptyString(executionId)) throw new TypeError('executionId is required.');
      return request(`/api/translation-dead-letter-queue/${encodeURIComponent(executionId)}/replay`, { method: 'POST' });
    }
  });

  async function request(url, options) {
    const response = await fetchImpl(url, options);
    if (!response?.ok) {
      const error = new Error(`Dead-letter queue API request failed with HTTP ${response?.status}.`);
      error.status = response?.status;
      try {
        const payload = await response.json();
        error.code = payload?.error?.code;
      } catch {
        // Keep the HTTP status as the stable fallback signal.
      }
      throw error;
    }
    return response.json();
  }
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}
