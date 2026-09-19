import { authenticatedFetch } from './accessToken.js';

export function createMeetingExportApiClient({ fetchImpl = globalThis.fetch, baseUrl = '' } = {}) {
  const request = authenticatedFetch(fetchImpl);
  return Object.freeze({
    async create(meetingId, input) {
      const response = await request(url(baseUrl, meetingId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input)
      });
      return parse(response, 'export');
    },

    async list(meetingId) {
      const response = await request(url(baseUrl, meetingId));
      const body = await parseJson(response);
      return Array.isArray(body?.exports) ? body.exports : [];
    },

    async get(meetingId, exportId) {
      const response = await request(`${url(baseUrl, meetingId)}/${encodeURIComponent(exportId)}`);
      return parse(response, 'export');
    },

    async createDownloadUrl(meetingId, exportId) {
      const response = await request(`${url(baseUrl, meetingId)}/${encodeURIComponent(exportId)}/download-url`, { method: 'POST' });
      return parse(response);
    },

    async remove(meetingId, exportId) {
      const response = await request(`${url(baseUrl, meetingId)}/${encodeURIComponent(exportId)}`, { method: 'DELETE' });
      await assertOk(response);
      return true;
    }
  });
}

async function parse(response, key) {
  await assertOk(response);
  const body = await parseJson(response);
  return key ? body?.[key] : body;
}

async function assertOk(response) {
  if (response?.ok) return;
  const error = new Error(`Meeting export request failed with HTTP ${response?.status}.`);
  error.status = response?.status;
  try {
    const body = await response.clone().json();
    error.code = body?.error?.code;
    error.requestId = body?.error?.requestId || body?.requestId;
  } catch {
    // Preserve HTTP status when the response is not JSON.
  }
  throw error;
}

async function parseJson(response) {
  return response.json();
}

function url(baseUrl, meetingId) {
  const prefix = String(baseUrl || '').replace(/\/+$/u, '');
  return `${prefix}/api/meetings/${encodeURIComponent(meetingId)}/exports`;
}
