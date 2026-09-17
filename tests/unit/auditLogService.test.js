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
  await assert.rejects(service.record({ action: 'unknown', result: 'success' }), { code: 'audit_action_invalid' });
  await assert.rejects(service.record({ action: 'user_enabled', result: 'pending' }), { code: 'audit_result_invalid' });
});
