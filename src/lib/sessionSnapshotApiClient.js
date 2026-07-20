export function createSessionSnapshotApiClient({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('session snapshot API client requires fetchImpl to be a function.');
  return Object.freeze({
    async sync(snapshot) {
      const sessionId = snapshot?.session?.id;
      if (typeof sessionId !== 'string' || sessionId.trim() === '') throw new TypeError('session snapshot session.id must be a non-empty string.');
      const response = await fetchImpl(`/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(snapshot)
      });
      if (!response?.ok) throw new Error(`Session snapshot API request failed with HTTP ${response?.status}.`);
      return response.json();
    }
  });
}
