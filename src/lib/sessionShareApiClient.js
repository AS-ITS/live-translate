import { authenticatedFetch } from './accessToken.js';

export function createSessionShareApiClient({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('session share API client requires fetchImpl to be a function.');
  const request = authenticatedFetch(fetchImpl);
  return {
    async list(sessionId) {
      const response = await request(`/api/sessions/${encodeURIComponent(sessionId)}/shares`);
      return parseOk(response, 'shares');
    },
    async create(sessionId, expiresAt = null, role = 'viewer') {
      const response = await request(`/api/sessions/${encodeURIComponent(sessionId)}/shares`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresAt, role })
      });
      return parseOk(response);
    },
    async revoke(sessionId, shareId) {
      const response = await request(`/api/sessions/${encodeURIComponent(sessionId)}/shares/${encodeURIComponent(shareId)}`, { method: 'DELETE' });
      return parseOk(response);
    }
  };
}

async function parseOk(response, expectedArrayKey = null) {
  if (!response?.ok) throw new Error(`Session share request failed with HTTP ${response?.status}.`);
  const body = await response.json();
  if (expectedArrayKey && !Array.isArray(body?.[expectedArrayKey])) throw new Error('Session share response is invalid.');
  return expectedArrayKey ? body[expectedArrayKey] : body;
}
