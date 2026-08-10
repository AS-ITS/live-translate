import { authenticatedFetch } from './accessToken.js';

export function createGlossaryApiClient({ fetchImpl = globalThis.fetch, baseUrl = '' } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('glossary API client requires fetchImpl to be a function.');
  fetchImpl = authenticatedFetch(fetchImpl);

  return Object.freeze({
    async listEntries() {
      const response = await fetchImpl(buildUrl(baseUrl, '/api/glossary'), { method: 'GET' });
      await assertOkResponse(response);
      return parseEntriesResponse(response);
    },

    async createEntry(entry) {
      const response = await fetchImpl(buildUrl(baseUrl, '/api/glossary/entries'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entry)
      });
      await assertOkResponse(response);
      return parseEntryResponse(response);
    },

    async updateEntry(id, entry) {
      const response = await fetchImpl(buildUrl(baseUrl, `/api/glossary/entries/${encodeURIComponent(id)}`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entry)
      });
      await assertOkResponse(response);
      return parseEntryResponse(response);
    },

    async deleteEntry(id) {
      const response = await fetchImpl(buildUrl(baseUrl, `/api/glossary/entries/${encodeURIComponent(id)}`), { method: 'DELETE' });
      await assertOkResponse(response);
      return parseJsonResponse(response);
    }
  });
}

function buildUrl(baseUrl, path) {
  const normalizedBaseUrl = String(baseUrl || '').replace(/\/+$/, '');
  return normalizedBaseUrl ? `${normalizedBaseUrl}${path}` : path;
}

async function assertOkResponse(response) {
  if (!response || typeof response !== 'object') throw new Error('Glossary API request did not return a response.');
  if (!response.ok) throw new Error(`Glossary API request failed with HTTP ${response.status}.`);
}

async function parseEntriesResponse(response) {
  const body = await parseJsonResponse(response);
  if (!body || typeof body !== 'object' || !Array.isArray(body.entries)) {
    throw new Error('Glossary response must contain an entries array.');
  }
  return body.entries;
}

async function parseEntryResponse(response) {
  const body = await parseJsonResponse(response);
  if (!body || typeof body !== 'object' || !body.entry || typeof body.entry !== 'object') {
    throw new Error('Glossary response must contain an entry object.');
  }
  return body.entry;
}

async function parseJsonResponse(response) {
  if (typeof response?.json !== 'function') throw new Error('Glossary API response cannot be parsed as JSON.');
  return response.json();
}
