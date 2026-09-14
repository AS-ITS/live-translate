import { authenticatedFetch } from './accessToken.js';

export function createSessionCommandApiClient({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('session command API client requires fetchImpl to be a function.');
  fetchImpl = authenticatedFetch(fetchImpl);

  return Object.freeze({
    async create(input = {}) {
      return request('/api/sessions', { method: 'POST', body: input });
    },

    async update(sessionId, patch = {}) {
      if (!nonEmptyString(sessionId)) throw new TypeError('sessionId is required.');
      return request(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'PATCH', body: patch });
    }
  });

  async function request(url, { method, body }) {
    const response = await fetchImpl(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!response?.ok) {
      let payload = null;
      let serverMessage = null;
      let requestId = response?.headers?.get?.('X-Request-Id') || null;
      let code = null;
      try {
        payload = await response.json();
        code = payload?.error?.code || null;
        serverMessage = payload?.error?.message || null;
        requestId = payload?.error?.requestId || requestId;
      } catch {
        // Keep the HTTP status as the stable fallback signal.
      }

      const diagnostic = [code, requestId ? `Request ID: ${requestId}` : null]
        .filter(Boolean)
        .join(', ');
      const error = new Error(
        `Session command API request failed with HTTP ${response?.status}.${diagnostic ? ` (${diagnostic})` : ''}`
      );
      error.status = response?.status;
      error.code = code;
      error.requestId = requestId;
      error.serverMessage = serverMessage;
      throw error;
    }
    return response.json();
  }
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}
