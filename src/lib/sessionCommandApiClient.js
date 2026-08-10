export function createSessionCommandApiClient({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('session command API client requires fetchImpl to be a function.');

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
      const error = new Error(`Session command API request failed with HTTP ${response?.status}.`);
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
