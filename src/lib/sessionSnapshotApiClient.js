import { authenticatedFetch } from './accessToken.js';

export function createSessionSnapshotApiClient({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('session snapshot API client requires fetchImpl to be a function.');
  fetchImpl = authenticatedFetch(fetchImpl);
  return Object.freeze({
    async sync(snapshot) {
      const sessionId = snapshot?.session?.id;
      if (typeof sessionId !== 'string' || sessionId.trim() === '') throw new TypeError('session snapshot session.id must be a non-empty string.');
      const response = await fetchImpl(`/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(snapshot)
      });
      if (!response?.ok) {
        const error = new Error(`Session snapshot API request failed with HTTP ${response?.status}.`);
        error.status = response?.status;
        try {
          const body = await response.json();
          error.code = body?.error?.code;
        } catch {
          // Keep the HTTP status as the stable fallback signal.
        }
        throw error;
      }
      return response.json();
    }
  });
}
