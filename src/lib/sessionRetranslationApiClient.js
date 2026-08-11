import { authenticatedFetch } from './accessToken.js';

export function createSessionRetranslationApiClient({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('session retranslation API client requires fetchImpl to be a function.');
  fetchImpl = authenticatedFetch(fetchImpl);
  return Object.freeze({
    async listProviders() {
      const response = await fetchImpl('/api/translation-providers', { method: 'GET' });
      if (!response || response.status < 200 || response.status >= 300) throw new Error(`Translation provider options request failed with HTTP ${response?.status}.`);
      const body = await response.json();
      return Array.isArray(body?.providers) ? body.providers : [];
    },

    async submit(sessionId, command) {
      if (typeof sessionId !== 'string' || sessionId.trim() === '') throw new TypeError('sessionId must be a non-empty string.');
      const response = await fetchImpl(`/api/sessions/${encodeURIComponent(sessionId)}/retranslations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command) });
      if (!response || response.status < 200 || response.status >= 300) throw new Error(`Session retranslation request failed with HTTP ${response?.status}.`);
      return response.json();
    }
  });
}
