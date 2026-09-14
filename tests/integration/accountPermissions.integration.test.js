import assert from 'node:assert/strict';
import test from 'node:test';
import { createAdminService } from '../../server/adminService.js';
import { createAuditLogService } from '../../server/auditLogService.js';
import { createProfileService } from '../../server/profileService.js';

const admin = { id: 'admin-1', role: 'super_admin', status: 'active' };

test('local member membership is required for recording and owner-only management', async () => {
  const profileService = createProfileService({ env: {} });
  const owner = { id: 'owner-1', role: 'member', status: 'active' };
  const member = { id: 'member-1', role: 'member', status: 'active' };
  await profileService.addMeetingMember(owner, 'meeting-1', 'member-1');
  assert.equal(await profileService.canRecordMeeting(member, 'meeting-1'), true);
  assert.equal(await profileService.canRecordMeeting(member, 'missing-meeting'), false);
  await assert.rejects(profileService.listMeetingMembers(member, 'meeting-1'), { code: 'auth_forbidden' });
});

test('admin adapter validates target and writes safe audit records around RPC failure', async () => {
  const entries = [];
  const auditLogService = createAuditLogService({ repository: { append: async (entry) => entries.push(entry) } });
  const service = createAdminService({
    env: { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'test-secret' },
    auditLogService,
    fetchImpl: async (url) => {
      if (url.includes('profiles?id=in.')) return new Response(JSON.stringify([
        { id: 'source-1', status: 'active' },
        { id: 'target-1', status: 'disabled' }
      ]));
      return new Response(JSON.stringify([]), { status: 200 });
    }
  });
  await assert.rejects(service.disableUser(admin, 'source-1', 'target-1', 'request-1'), { code: 'transfer_target_invalid' });
  assert.equal(entries.at(-1).result, 'failure');
  assert.equal(entries.every((entry) => !Object.hasOwn(entry, 'test-secret')), true);
});
