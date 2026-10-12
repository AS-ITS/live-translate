import { authenticatedFetch } from './accessToken.js';

export function createAccountManagementApiClient({ fetchImpl = globalThis.fetch, baseUrl = '' } = {}) {
  const request = authenticatedFetch(fetchImpl);
  async function call(path, options = {}) {
    const response = await request(`${baseUrl}${path}`, options);
    const body = response.status === 204 ? null : await response.json();
    if (!response.ok) { const error = new Error(body?.error?.message || '帳號操作失敗。'); error.code = body?.error?.code; error.status = response.status; error.requestId = response.headers?.get?.('x-request-id') || body?.error?.requestId || body?.requestId; throw error; }
    return body;
  }
  return Object.freeze({
    listUsers: async ({ page = 1, pageSize = 12, query = '', status = 'all' } = {}) => {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize), query, status });
      return call(`/api/admin/users?${params.toString()}`);
    },
    listAuditLogs: async ({ page = 1, pageSize = 25, query = '', action = 'all', result = 'all' } = {}) => {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize), query, action, result });
      return call(`/api/admin/audit-logs?${params.toString()}`);
    },
    updateRole: async (userId, role) => call(`/api/admin/users/${encodeURIComponent(userId)}/role`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role })
    }),
    enable: async (userId) => (await call(`/api/admin/users/${encodeURIComponent(userId)}/enable`, { method: 'POST' })).user,
    disable: async (userId, transferToUserId) => (await call(`/api/admin/users/${encodeURIComponent(userId)}/disable`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ transferToUserId }) })).user
  });
}
