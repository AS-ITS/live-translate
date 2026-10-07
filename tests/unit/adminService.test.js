import assert from 'node:assert/strict';
import test from 'node:test';
import { createAdminService } from '../../server/adminService.js';

const env = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'service-key' };
const admin = { id: 'admin-1', role: 'super_admin', status: 'active' };
const json = (body, status = 200, contentRange) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...(contentRange ? { 'content-range': contentRange } : {}) } });

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

test('admin re-enables only disabled users', async () => {
  const service = createAdminService({ env, fetchImpl: async (url, options) => {
    assert.match(url, /status=eq\.disabled/u);
    assert.equal(options.method, 'PATCH');
    return json([{ id: 'user-2', status: 'active' }]);
  } });
  assert.equal((await service.enableUser(admin, 'user-2', 'request-enable-1')).status, 'active');

  const notDisabled = createAdminService({ env, fetchImpl: async () => json([]) });
  await assert.rejects(notDisabled.enableUser(admin, 'pending-1', 'request-enable-2'), { code: 'account_not_disabled', status: 409 });
});

test('admin updates account roles through the atomic RPC and preserves account status', async () => {
  const calls = [];
  const service = createAdminService({ env, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return json([{ outcome: 'ok', changed: true, id: 'user-2', email: 'user@example.com', role: 'super_admin', status: 'disabled', updated_at: '2026-10-07T00:00:00Z' }]);
  } });

  const result = await service.updateUserRole(admin, 'user-2', 'super_admin', 'request-role-1');

  assert.equal(result.changed, true);
  assert.equal(result.user.role, 'super_admin');
  assert.equal(result.user.status, 'disabled');
  assert.match(calls[0].url, /\/rest\/v1\/rpc\/update_account_role$/u);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    p_actor_user_id: 'admin-1',
    p_target_user_id: 'user-2',
    p_new_role: 'super_admin',
    p_request_id: 'request-role-1'
  });
});

test('same-role account update returns changed=false without synthesizing an audit event', async () => {
  const audit = [];
  const service = createAdminService({
    env,
    auditLogService: { record: async (entry) => audit.push(entry) },
    fetchImpl: async () => json([{ outcome: 'ok', changed: false, id: 'user-2', email: 'user@example.com', role: 'member', status: 'pending', updated_at: '2026-10-01T00:00:00Z' }])
  });

  const result = await service.updateUserRole(admin, 'user-2', 'member', 'request-role-same');

  assert.equal(result.changed, false);
  assert.equal(result.user.status, 'pending');
  assert.deepEqual(audit, []);
});

test('account role update validates roles and maps atomic RPC domain failures', async () => {
  const invalid = createAdminService({ env, fetchImpl: async () => { throw new Error('fetch must not run'); } });
  await assert.rejects(invalid.updateUserRole(admin, 'user-2', 'owner', 'request-invalid'), { code: 'invalid_account_role', status: 400 });
  await assert.rejects(invalid.updateUserRole({ id: 'member-1', role: 'member', status: 'active' }, 'user-2', 'super_admin', 'request-member'), { code: 'auth_forbidden', status: 403 });

  for (const [outcome, status] of [['account_not_found', 404], ['cannot_demote_self', 409], ['last_super_admin', 409], ['auth_forbidden', 403]]) {
    const service = createAdminService({ env, fetchImpl: async () => json([{ outcome, changed: false }]) });
    await assert.rejects(service.updateUserRole(admin, 'user-2', 'member', `request-${outcome}`), { code: outcome, status });
  }
});

test('admin list validates pagination and filter options', async () => {
  const service = createAdminService({ env, fetchImpl: async () => json([], 200, '*/0') });
  await assert.rejects(service.listUsers(admin, { page: 0 }), { code: 'invalid_request', status: 400 });
  await assert.rejects(service.listUsers(admin, { pageSize: 16 }), { code: 'invalid_request', status: 400 });
  await assert.rejects(service.listUsers(admin, { status: 'pending' }), { code: 'invalid_request', status: 400 });
  await assert.rejects(service.listUsers(admin, { status: 'unknown' }), { code: 'invalid_request', status: 400 });
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

test('admin audit filters accept login events', async () => {
  const urls = [];
  const service = createAdminService({ env, fetchImpl: async (url) => {
    urls.push(url);
    return json([], 200, '0-24/0');
  } });
  await service.listAuditLogs(admin, { action: 'auth_login', result: 'failure' });
  assert.match(urls[0], /action=eq\.auth_login/);
  assert.match(urls[0], /result=eq\.failure/);
});
