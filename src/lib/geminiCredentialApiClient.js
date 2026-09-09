import { authenticatedFetch } from './accessToken.js';

export function createGeminiCredentialApiClient({ fetchImpl = globalThis.fetch, baseUrl = '' } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('credential API client requires fetch.');
  const request = authenticatedFetch(fetchImpl);
  const url = `${String(baseUrl || '').replace(/\/$/u, '')}/api/profile/gemini-credential`;
  return Object.freeze({
    async get() { return parse(await request(url, { method: 'GET' })); },
    async save(apiKey) {
      return parse(await request(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey }) }));
    },
    async remove() {
      const response = await request(url, { method: 'DELETE' });
      if (!response.ok) throw new Error(`Credential request failed with HTTP ${response.status}.`);
    }
  });
}

async function parse(response) {
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error?.message || `Credential request failed with HTTP ${response.status}.`);
  return body?.credential || body;
}
