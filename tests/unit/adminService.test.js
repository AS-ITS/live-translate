import assert from 'node:assert/strict';
import test from 'node:test';
import { createAdminService } from '../../server/adminService.js';

function response(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); }

test('admin list returns safe profile fields and disable uses transfer RPC', async () => {
  const calls = [];
  const audit = [];
  const service = createAdminService({
    env: { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'service-key' },
    fetchImpl: async (url, options) => { calls.push({ url, options }); return response([{ id: 'user-2', email: 'user@example.com', role: 'member', status: 'active' }]); },
    auditLogService: { record: async (entry) => audit.push(entry) }
  });
  assert.deepEqual(await service.listUsers(), [{ id: 'user-2', email: 'user@example.com', role: 'member', status: 'active' }]);
  await service.disableUser({ id: 'admin-1' }, 'user-2', 'user-3', 'request-1');
  assert.match(calls[1].url, /rpc\/disable_user_with_transfer/);
  assert.equal(JSON.parse(calls[1].options.body).target_user_id, 'user-2');
  assert.equal(audit.every((entry) => !Object.keys(entry).some((key) => /token|secret|key|audio|transcript/i.test(key))), true);
});

test('admin cannot disable itself', async () => {
  const service = createAdminService({
    env: { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'service-key' },
    fetchImpl: async () => response([])
  });
  await assert.rejects(service.disableUser({ id: 'same' }, 'same', 'other', 'request-1'), { code: 'cannot_disable_self', status: 400 });
});

