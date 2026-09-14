import assert from 'node:assert/strict';
import test from 'node:test';
import { createAdminService } from '../../server/adminService.js';

const env = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'service-key' };
const admin = { id: 'admin-1', role: 'super_admin', status: 'active' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('admin lists safe profile fields and disables through transfer RPC', async () => {
  const calls = []; const audit = [];
  const service = createAdminService({ env, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url.includes('profiles?select=')) return json([{ id: 'user-2', email: 'user@example.com', role: 'member', status: 'active' }]);
    if (url.includes('profiles?id=in.')) return json([{ id: 'user-2', status: 'active' }, { id: 'user-3', status: 'active' }]);
    return json([{ id: 'user-2', status: 'disabled' }]);
  }, auditLogService: { record: async (entry) => audit.push(entry) } });
  assert.equal((await service.listUsers(admin))[0].id, 'user-2');
  await service.disableUser(admin, 'user-2', 'user-3', 'request-1');
  assert.match(calls.at(-1).url, /rpc\/disable_user_with_transfer/);
  assert.equal(audit.every((entry) => !Object.keys(entry).some((key) => /token|secret|key|audio|transcript/i.test(key))), true);
});

test('admin rejects missing actor role and cannot disable itself', async () => {
  const service = createAdminService({ env, fetchImpl: async () => json([]) });
  await assert.rejects(service.disableUser({ id: 'same' }, 'same', 'other', 'request-1'), { code: 'auth_forbidden', status: 403 });
  await assert.rejects(service.disableUser({ ...admin, id: 'same' }, 'same', 'other', 'request-1'), { code: 'cannot_disable_self', status: 400 });
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
