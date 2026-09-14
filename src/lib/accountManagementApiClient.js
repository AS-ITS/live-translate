import { authenticatedFetch } from './accessToken.js';

export function createAccountManagementApiClient({ fetchImpl = globalThis.fetch, baseUrl = '' } = {}) {
  const request = authenticatedFetch(fetchImpl);
  async function call(path, options = {}) {
    const response = await request(`${baseUrl}${path}`, options);
    const body = response.status === 204 ? null : await response.json();
    if (!response.ok) { const error = new Error(body?.error?.message || '帳號操作失敗。'); error.code = body?.error?.code; error.status = response.status; throw error; }
    return body;
  }
  return Object.freeze({
    listUsers: async () => (await call('/api/admin/users')).users || [],
    enable: async (userId) => (await call(`/api/admin/users/${encodeURIComponent(userId)}/enable`, { method: 'POST' })).user,
    disable: async (userId, transferToUserId) => (await call(`/api/admin/users/${encodeURIComponent(userId)}/disable`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ transferToUserId }) })).user
  });
}

