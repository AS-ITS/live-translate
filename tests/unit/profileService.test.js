import assert from 'node:assert/strict';
import test from 'node:test';
import { createProfileService } from '../../server/profileService.js';

test('local profile service stores and removes meeting members', async () => {
  const service = createProfileService({ env: {} });
  const user = { id: 'owner-1', email: 'owner@example.com' };
  await service.addMeetingMember(user, 'meeting-1', 'member@example.com');
  assert.deepEqual(await service.listMeetingMembers(user, 'meeting-1'), [{
 userId: 'member@example.com', email: 'member@example.com', ownerUserId: 'owner-1', meetingId: 'meeting-1', canRecord: true
  }]);
  await service.removeMeetingMember(user, 'meeting-1', 'member@example.com');
  assert.deepEqual(await service.listMeetingMembers(user, 'meeting-1'), []);
});

test('local active super admin can record meetings without becoming the owner', async () => {
  const service = createProfileService({ env: {} });
  const admin = { id: 'admin-1', role: 'super_admin', status: 'active' };
  await service.addMeetingMember({ id: 'owner-1' }, 'meeting-1', 'member@example.com');
  assert.equal(await service.canRecordMeeting(admin, 'meeting-1'), true);
  assert.equal(await service.getMeetingOwner('meeting-1'), 'owner-1');
});

test('pending and disabled super admins cannot record local meetings', async () => {
  const service = createProfileService({ env: {} });
  await service.addMeetingMember({ id: 'owner-1' }, 'meeting-1', 'member@example.com');
  assert.equal(await service.canRecordMeeting({ id: 'admin-1', role: 'super_admin', status: 'pending' }, 'meeting-1'), false);
  assert.equal(await service.canRecordMeeting({ id: 'admin-1', role: 'super_admin', status: 'disabled' }, 'meeting-1'), false);
});

const cloudEnv = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SECRET_KEY: 'service-role-key'
};

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' }
});

test('trusted backend activates a first-login pending member', async () => {
  const calls = [];
  const service = createProfileService({ env: cloudEnv, fetchImpl: async (url, options = {}) => {
    calls.push({ url, options });
    if (url.includes('/rpc/activate_pending_profile')) {
      return json([{ id: 'member-1', email: 'member@example.com', role: 'member', status: 'active' }]);
    }
    return json([{ id: 'member-1', email: 'member@example.com', role: 'member', status: 'pending' }]);
  } });

  const profile = await service.getProfile({ id: 'member-1', email: 'member@example.com' }, { activatePending: true });

  assert.equal(profile.status, 'active');
  assert.equal(profile.role, 'member');
  assert.match(calls[1].url, /\/rest\/v1\/rpc\/activate_pending_profile$/u);
  assert.equal(calls[1].options.headers.Authorization, 'Bearer service-role-key');
  assert.deepEqual(JSON.parse(calls[1].options.body), { target_user_id: 'member-1' });
});

test('pending activation preserves a super admin role', async () => {
  const service = createProfileService({ env: cloudEnv, fetchImpl: async (url) => url.includes('/rpc/activate_pending_profile')
    ? json([{ id: 'admin-1', email: 'admin@example.com', role: 'super_admin', status: 'active' }])
    : json([{ id: 'admin-1', email: 'admin@example.com', role: 'super_admin', status: 'pending' }]) });

  const profile = await service.getProfile({ id: 'admin-1' }, { activatePending: true });
  assert.equal(profile.role, 'super_admin');
  assert.equal(profile.status, 'active');
});

test('disabled profiles are never sent through automatic activation', async () => {
  let rpcCalled = false;
  const service = createProfileService({ env: cloudEnv, fetchImpl: async (url) => {
    if (url.includes('/rpc/activate_pending_profile')) rpcCalled = true;
    return json([{ id: 'disabled-1', email: 'disabled@example.com', role: 'member', status: 'disabled' }]);
  } });

  const profile = await service.getProfile({ id: 'disabled-1' }, { activatePending: true });
  assert.equal(profile.status, 'disabled');
  assert.equal(rpcCalled, false);
});

test('concurrent disable result is not mistaken for successful activation', async () => {
  const service = createProfileService({ env: cloudEnv, fetchImpl: async (url) => url.includes('/rpc/activate_pending_profile')
    ? json([{ id: 'member-1', email: 'member@example.com', role: 'member', status: 'disabled' }])
    : json([{ id: 'member-1', email: 'member@example.com', role: 'member', status: 'pending' }]) });

  const profile = await service.getProfile({ id: 'member-1' }, { activatePending: true });
  assert.equal(profile.status, 'disabled');
});

test('missing profile and activation failures fail closed', async () => {
  const missing = createProfileService({ env: cloudEnv, fetchImpl: async () => json([]) });
  await assert.rejects(missing.getProfile({ id: 'missing-1' }, { activatePending: true }), { code: 'profile_not_found', status: 503 });

  const failed = createProfileService({ env: cloudEnv, fetchImpl: async (url) => url.includes('/rpc/activate_pending_profile')
    ? json({ message: 'failed' }, 500)
    : json([{ id: 'member-1', role: 'member', status: 'pending' }]) });
  await assert.rejects(failed.getProfile({ id: 'member-1' }, { activatePending: true }), { code: 'supabase_request_failed', status: 500 });
});
