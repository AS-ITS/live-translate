import { authenticatedFetch } from './accessToken.js';

export function createMeetingManagementApiClient({ fetchImpl = globalThis.fetch, baseUrl = '' } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('meeting management API client requires fetchImpl to be a function.');
  const request = authenticatedFetch(fetchImpl);

  return Object.freeze({
    async create(input = {}) {
      return parseMeeting(await request(buildUrl(baseUrl, '/api/meetings'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...input, draft: true })
      }));
    },
    async update(meetingId, input = {}) {
      return parseMeeting(await request(buildUrl(baseUrl, `/api/meetings/${encodeURIComponent(meetingId)}`), {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input)
      }));
    },
    async delete(meetingId) {
      const response = await request(buildUrl(baseUrl, `/api/meetings/${encodeURIComponent(meetingId)}`), { method: 'DELETE' });
      await assertOk(response);
    },
    async listShares(meetingId) {
      const response = await request(buildUrl(baseUrl, `/api/meetings/${encodeURIComponent(meetingId)}/shares`));
      await assertOk(response);
      const body = await response.json();
      return Array.isArray(body?.shares) ? body.shares : [];
    },
    async createShare(meetingId, expiresAt = null) {
      return this.createShareWithRole(meetingId, 'recorder', expiresAt);
    },
    async createViewerShare(meetingId, expiresAt = null) {
      return this.createShareWithRole(meetingId, 'viewer', expiresAt);
    },
    async createShareWithRole(meetingId, role = 'recorder', expiresAt = null) {
      const response = await request(buildUrl(baseUrl, `/api/meetings/${encodeURIComponent(meetingId)}/shares`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role, expiresAt })
      });
      await assertOk(response);
      return response.json();
    },
    async ensureShareWithRole(meetingId, role = 'recorder', expiresAt = null) {
      const response = await request(buildUrl(baseUrl, `/api/meetings/${encodeURIComponent(meetingId)}/shares`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role, expiresAt, ensureExisting: true })
      });
      await assertOk(response);
      return response.json();
    },
    async revokeShare(meetingId, shareId) {
      const response = await request(buildUrl(baseUrl, `/api/meetings/${encodeURIComponent(meetingId)}/shares/${encodeURIComponent(shareId)}`), { method: 'DELETE' });
      await assertOk(response);
    }
  });
}

async function parseMeeting(response) {
  await assertOk(response);
  const body = await response.json();
  return body?.meeting || body;
}

async function assertOk(response) {
  if (!response?.ok) {
    const error = new Error(`Meeting management request failed with HTTP ${response?.status}.`);
    error.status = response?.status;
    throw error;
  }
}

function buildUrl(baseUrl, path) {
  const normalizedBaseUrl = String(baseUrl || '').replace(/\/+$/, '');
  return normalizedBaseUrl ? `${normalizedBaseUrl}${path}` : path;
}
