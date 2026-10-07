import assert from 'node:assert/strict';
import test from 'node:test';
import { createAdminService } from '../../server/adminService.js';
import { createMeetingMembershipService } from '../../src/application/meetingMembershipService.js';

const env = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'service-key' };
const admin = { id: 'admin-1', role: 'super_admin', status: 'active' };

test('audit query validates filters and returns only safe fields with exact pagination', async () => {
  const service = createAdminService({
    env,
    fetchImpl: async (url, options) => {
      assert.match(url, /audit_logs\?select=actor_user_id,target_user_id,target_email,target_meeting_id,old_role,new_role,request_id,action,result,created_at&order=created_at.desc/);
      assert.match(url, /action=eq\.member_invited/);
      assert.match(url, /result=eq\.failure/);
      assert.equal(options.headers.Range, '25-49');
      assert.equal(options.headers.Prefer, 'count=exact,return=representation');
      return new Response(JSON.stringify([{ actor_user_id: 'a', target_user_id: 'b', target_meeting_id: 'm', request_id: 'r', action: 'member_invited', result: 'failure', created_at: '2026-09-15T00:00:00Z', token: 'must-not-return' }]), { status: 200, headers: { 'content-range': '25-49/51' } });
    }
  });
  const result = await service.listAuditLogs(admin, { page: 2, pageSize: 25, action: 'member_invited', result: 'failure', query: 'meeting-1' });
  assert.deepEqual(result.pagination, { page: 2, pageSize: 25, total: 51, totalPages: 3 });
  assert.equal(result.logs[0].token, undefined);
  await assert.rejects(service.listAuditLogs(admin, { pageSize: 12 }), { code: 'invalid_request', status: 400 });
  await assert.rejects(service.listAuditLogs({ ...admin, status: 'disabled' }), { code: 'auth_forbidden', status: 403 });
});

test('meeting member recording permission is enforced without removing membership', async () => {
  const service = createMeetingMembershipService({
    profileRepository: { getProfile: async () => ({ status: 'active' }) },
    meetingRepository: { getMeeting: async () => ({ ownerUserId: 'owner-1' }) },
    membershipRepository: { find: async () => ({ canRecord: false }), list: async () => [] }
  });
  assert.equal(await service.canRecord('meeting-1', 'member-1'), false);
  assert.equal(await service.canRecord('meeting-1', 'owner-1'), true);
});
