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
