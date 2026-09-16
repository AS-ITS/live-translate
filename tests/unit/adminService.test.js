import assert from 'node:assert/strict';
import test from 'node:test';
import { createAdminService } from '../../server/adminService.js';

const env = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'service-key' };
const admin = { id: 'admin-1', role: 'super_admin', status: 'active' };
const json = (body, status = 200, contentRange) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...(contentRange ? { 'content-range': contentRange } : {}) } });

test('admin creates a confirmed active member without exposing the password', async () => {
  const calls = [];
  const audit = [];
  const service = createAdminService({ env, fetchImpl: async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/auth/v1/admin/users')) return json({ id: 'new-user-1', email: 'new@example.com' });
    if (url.includes('/rest/v1/profiles?id=eq.new-user-1')) return json([{ id: 'new-user-1', email: 'new@example.com', role: 'member', status: 'active' }]);
    throw new Error(`unexpected request: ${url}`);
  }, auditLogService: { record: async (entry) => audit.push(entry) } });

  const user = await service.createUser(admin, { email: ' new@example.com ', password: 'temporary-password', confirmPassword: 'temporary-password' }, 'request-create-1');
  assert.deepEqual(user, { id: 'new-user-1', email: 'new@example.com', role: 'member', status: 'active' });
  assert.equal(calls[0].options.body.includes('temporary-password'), true);
  assert.equal(audit[0].action, 'user_created');
  assert.equal(audit.every((entry) => !JSON.stringify(entry).includes('temporary-password')), true);
});

test('admin rejects invalid account creation details', async () => {
  const audit = [];
  const service = createAdminService({ env, fetchImpl: async () => json({}), auditLogService: { record: async (entry) => audit.push(entry) } });
  await assert.rejects(service.createUser(admin, { email: 'new@example.com', password: 'one', confirmPassword: 'two' }, 'request-create-2'), { code: 'account_creation_invalid', status: 400 });
  assert.equal(audit[0].action, 'user_created');
});

test('admin lists safe profile fields and disables through transfer RPC', async () => {
  const calls = []; const audit = [];
  const service = createAdminService({ env, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url.includes('status=eq.active&order=email.asc')) return json([{ id: 'user-2', email: 'user@example.com' }]);
    if (url.includes('status=eq.active')) return json([{ id: 'user-2' }], 200, '0-0/1');
    if (url.includes('status=eq.disabled')) return json([{ id: 'user-3' }], 200, '0-0/1');
    if (url.includes('profiles?select=')) return json([{ id: 'user-2', email: 'user@example.com', role: 'member', status: 'active' }], 200, '0-0/1');
    if (url.includes('profiles?select=id')) return json([{ id: 'user-2' }], 200, '0-0/1');
    if (url.includes('profiles?id=in.')) return json([{ id: 'user-2', status: 'active' }, { id: 'user-3', status: 'active' }]);
    return json([{ id: 'user-2', status: 'disabled' }]);
  }, auditLogService: { record: async (entry) => audit.push(entry) } });
  const listed = await service.listUsers(admin, { page: 1, pageSize: 12, query: 'user', status: 'active' });
  assert.equal(listed.users[0].id, 'user-2');
  assert.deepEqual(listed.pagination, { page: 1, pageSize: 12, total: 1, totalPages: 1 });
  assert.deepEqual(listed.counts, { all: 1, active: 1, disabled: 1 });
  assert.deepEqual(listed.transferTargets, [{ id: 'user-2', email: 'user@example.com' }]);
  assert.match(calls[0].url, /status=eq.active/);
  assert.equal(calls[0].options.headers.Range, '0-11');
  await service.disableUser(admin, 'user-2', 'user-3', 'request-1');
  assert.match(calls.at(-1).url, /rpc\/disable_user_with_transfer/);
  assert.equal(audit.every((entry) => !Object.keys(entry).some((key) => /token|secret|key|audio|transcript/i.test(key))), true);
});

test('admin rejects missing actor role and cannot disable itself', async () => {
  const service = createAdminService({ env, fetchImpl: async () => json([]) });
  await assert.rejects(service.disableUser({ id: 'same' }, 'same', 'other', 'request-1'), { code: 'auth_forbidden', status: 403 });
  await assert.rejects(service.disableUser({ ...admin, id: 'same' }, 'same', 'other', 'request-1'), { code: 'cannot_disable_self', status: 400 });
});

test('admin list validates pagination and filter options', async () => {
  const service = createAdminService({ env, fetchImpl: async () => json([], 200, '*/0') });
  await assert.rejects(service.listUsers(admin, { page: 0 }), { code: 'invalid_request', status: 400 });
  await assert.rejects(service.listUsers(admin, { pageSize: 16 }), { code: 'invalid_request', status: 400 });
  await assert.rejects(service.listUsers(admin, { status: 'pending' }), { code: 'invalid_request', status: 400 });
  await assert.rejects(service.listUsers(admin, { query: 'x'.repeat(101) }), { code: 'invalid_request', status: 400 });
});

test('audit write failure emits only safe observability fields', async () => {
  const events = [];
  const service = createAdminService({
    env,
    fetchImpl: async (url) => url.includes('profiles?id=in.')
      ? json([{ id: 'user-2', status: 'active' }, { id: 'user-3', status: 'active' }])
      : json({ error: 'rpc unavailable' }, 500),
    auditLogService: { record: async () => { throw new Error('contains stack and credential token'); } },
    observability: { log: (event) => events.push(event) }
  });

  await assert.rejects(service.disableUser(admin, 'user-2', 'user-3', 'request-1'), { code: 'supabase_request_failed' });
  assert.deepEqual(events, [
    { event: 'audit_write_failed', action: 'asset_transfer', result: 'failure', requestId: 'request-1' },
    { event: 'audit_write_failed', action: 'user_disabled', result: 'failure', requestId: 'request-1' }
  ]);
});

test('audit UUID searches use exact ID filters and request IDs remain partial matches', async () => {
  const urls = [];
  const service = createAdminService({ env, fetchImpl: async (url) => {
    urls.push(url);
    return json([], 200, '0-24/0');
  } });
  await service.listAuditLogs(admin, { query: '550e8400-e29b-41d4-a716-446655440000' });
  assert.match(urls[0], /actor_user_id\.eq\.550e8400-e29b-41d4-a716-446655440000/);
  assert.match(urls[0], /target_user_id\.eq\.550e8400-e29b-41d4-a716-446655440000/);
  assert.match(urls[0], /target_meeting_id\.eq\.550e8400-e29b-41d4-a716-446655440000/);
  assert.doesNotMatch(urls[0], /\.ilike/);
  urls.length = 0;
  await service.listAuditLogs(admin, { query: 'request-123' });
  assert.match(urls[0], /request_id\.ilike\.\*request-123\*/);
  assert.doesNotMatch(urls[0], /(?:actor_user_id|target_user_id|target_meeting_id)\.(?:eq|ilike)/);
});
