import { authenticatedFetch } from './accessToken.js';
import { meetingApiErrorMessage } from './meetingApiError.js';

export function createMeetingManagementApiClient({ fetchImpl = globalThis.fetch, baseUrl = '' } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('meeting management API client requires fetchImpl to be a function.');
  const request = authenticatedFetch(fetchImpl);

  return Object.freeze({
    async previewPrivateGlossaryImport(input) {
      const response = await request(buildUrl(baseUrl, '/api/meetings/glossary/import/preview'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input)
      });
      await assertOk(response);
      return response.json();
    },

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
    async listMembers(meetingId) {
      const response = await request(buildUrl(baseUrl, `/api/meetings/${encodeURIComponent(meetingId)}/members`));
      await assertOk(response);
      const body = await response.json();
      return Array.isArray(body?.members) ? body.members : [];
    },
    async addMember(meetingId, email) {
      const response = await request(buildUrl(baseUrl, `/api/meetings/${encodeURIComponent(meetingId)}/members`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email })
      });
      await assertOk(response);
      return (await response.json())?.members?.[0] || null;
    },
    async removeMember(meetingId, userId) {
      const response = await request(buildUrl(baseUrl, `/api/meetings/${encodeURIComponent(meetingId)}/members/${encodeURIComponent(userId)}`), { method: 'DELETE' });
      await assertOk(response);
    },
    async updateMemberRecording(meetingId, userId, canRecord) {
      const response = await request(buildUrl(baseUrl, `/api/meetings/${encodeURIComponent(meetingId)}/members/${encodeURIComponent(userId)}`), {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ canRecord })
      });
      await assertOk(response);
      return (await response.json())?.member || null;
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

export function meetingManagementErrorMessage(error, fallback = '會議操作失敗，請稍後再試。') {
  const managementMessages = {
    auth_forbidden: '目前帳號沒有權限執行此操作。',
    meeting_checkpoint_unavailable: '會議儲存服務目前未配置。',
    meeting_settings_locked: '已完成的會議不可修改設定。',
    unsupported_language: '選取的語言目前不支援。'
  };
  const managementMessage = managementMessages[error?.code];
  if (managementMessage) {
    return error?.requestId ? `${managementMessage}（識別碼：${error.requestId}）` : managementMessage;
  }

  if (error?.code === 'meeting_share_invalid' || (error?.status === 404 && !error?.code)) {
    const message = '分享連結服務找不到，請確認部署的 API 版本。';
    return error?.requestId ? `${message}（識別碼：${error.requestId}）` : message;
  }

  return meetingApiErrorMessage(error, fallback);
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
    try {
      const body = typeof response.clone === 'function'
        ? await response.clone().json()
        : await response.json();
      error.code = body?.error?.code;
      error.apiMessage = body?.error?.message;
      error.requestId = body?.error?.requestId || body?.requestId;
    } catch {
      // Preserve the HTTP status when the error response is not JSON.
    }
    throw error;
  }
}

function buildUrl(baseUrl, path) {
  const normalizedBaseUrl = String(baseUrl || '').replace(/\/+$/, '');
  return normalizedBaseUrl ? `${normalizedBaseUrl}${path}` : path;
}
