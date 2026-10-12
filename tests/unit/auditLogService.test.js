import assert from 'node:assert/strict';
import test from 'node:test';
import { createAuditLogService } from '../../server/auditLogService.js';

test('audit records use the allowlisted actions and fields', async () => {
  const entries = [];
  const service = createAuditLogService({ repository: { append: async (entry) => entries.push(entry) } });
const safe = await service.record({ action: 'asset_transfer', result: 'success', actor_user_id: 'a', target_user_id: 'b', request_id: 'r', transcript: 'secret text', api_key: 'secret' });
  assert.equal(safe.transcript, undefined);
  assert.equal(safe.api_key, undefined);
assert.equal(entries[0].action, 'asset_transfer');
const approval = await service.record({ action: 'user_approved', result: 'success', target_user_id: 'pending' });
assert.equal(approval.action, 'user_approved');
const permission = await service.record({ action: 'member_recording_permission_changed', result: 'success', target_user_id: 'member', target_meeting_id: 'meeting', signed_url: 'https://signed.example', transcript_text: 'must not persist' });
assert.equal(permission.action, 'member_recording_permission_changed');
assert.equal(permission.signed_url, undefined);
assert.equal(permission.transcript_text, undefined);
const login = await service.record({ action: 'auth_login', result: 'failure', actor_user_id: 'pending', request_id: 'login-request' });
assert.equal(login.action, 'auth_login');
assert.equal(login.result, 'failure');
const promotion = await service.record({ action: 'account.role.promoted', result: 'success', actor_user_id: 'admin', target_user_id: 'member', target_email: 'member@example.com', old_role: 'member', new_role: 'super_admin' });
assert.equal(promotion.target_email, 'member@example.com');
assert.equal(promotion.old_role, 'member');
assert.equal(promotion.new_role, 'super_admin');
  await assert.rejects(service.record({ action: 'unknown', result: 'success' }), { code: 'audit_action_invalid' });
  await assert.rejects(service.record({ action: 'user_enabled', result: 'pending' }), { code: 'audit_result_invalid' });
});
