import { authenticatedFetch } from './accessToken.js';

export class GlossaryApiError extends Error {
  constructor({ status, code, message, details }) {
    super(message);
    this.name = 'GlossaryApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function createGlossaryApiClient({ fetchImpl = globalThis.fetch, baseUrl = '' } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('glossary API client requires fetchImpl to be a function.');
  fetchImpl = authenticatedFetch(fetchImpl);

  return Object.freeze({
    async previewImport(input) {
      const response = await fetchImpl(buildUrl(baseUrl, '/api/glossary/import/preview'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
      await assertOkResponse(response, { notFoundMessage: '找不到匯入 API，請重新啟動後端服務並確認 dev_backend_origin 設定。' });
      return parseJsonResponse(response);
    },

    async importEntries(input) {
      const response = await fetchImpl(buildUrl(baseUrl, '/api/glossary/import'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
      await assertOkResponse(response, { notFoundMessage: '找不到匯入 API，請重新啟動後端服務並確認 dev_backend_origin 設定。' });
      return parseJsonResponse(response);
    },

    async listCategories() {
      const response = await fetchImpl(buildUrl(baseUrl, '/api/glossary/categories'), { method: 'GET' });
      await assertOkResponse(response);
      const body = await parseJsonResponse(response);
      if (!body || !Array.isArray(body.categories)) throw new Error('Glossary response must contain a categories array.');
      return body.categories;
    },

    async createCategory(category) {
      const response = await fetchImpl(buildUrl(baseUrl, '/api/glossary/categories'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(category) });
      await assertOkResponse(response);
      return parseCategoryResponse(response);
    },

    async updateCategory(id, category) {
      const response = await fetchImpl(buildUrl(baseUrl, `/api/glossary/categories/${encodeURIComponent(id)}`), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(category) });
      await assertOkResponse(response);
      return parseCategoryResponse(response);
    },

    async reorderCategories(categoryIds) {
      const response = await fetchImpl(buildUrl(baseUrl, '/api/glossary/categories/order'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ categoryIds }) });
      await assertOkResponse(response);
      const body = await parseJsonResponse(response);
      if (!body || !Array.isArray(body.categories)) throw new Error('Glossary response must contain a categories array.');
      return body.categories;
    },

    async deleteCategory(id) {
      const response = await fetchImpl(buildUrl(baseUrl, `/api/glossary/categories/${encodeURIComponent(id)}`), { method: 'DELETE' });
      await assertOkResponse(response);
      return parseJsonResponse(response);
    },

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

async function assertOkResponse(response, { notFoundMessage } = {}) {
  if (!response || typeof response !== 'object') throw new Error('Glossary API request did not return a response.');
  if (response.ok) return;
  let body;
  try {
    body = typeof response.json === 'function' ? await response.json() : undefined;
  } catch {
    body = undefined;
  }
  throw new GlossaryApiError({
    status: response.status,
    code: body?.error?.code,
    message: response.status === 404 && notFoundMessage ? notFoundMessage : body?.error?.message || `Glossary API request failed with HTTP ${response.status}.`,
    details: body?.error?.details
  });
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

async function parseCategoryResponse(response) {
  const body = await parseJsonResponse(response);
  if (!body || typeof body !== 'object' || !body.category || typeof body.category !== 'object') throw new Error('Glossary response must contain a category object.');
  return body.category;
}

async function parseJsonResponse(response) {
  if (typeof response?.json !== 'function') throw new Error('Glossary API response cannot be parsed as JSON.');
  return response.json();
}
