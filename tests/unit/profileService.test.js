import assert from 'node:assert/strict';
import test from 'node:test';
import { createProfileService } from '../../server/profileService.js';

test('local profile service stores and removes meeting members', async () => {
  const service = createProfileService({ env: {} });
  const user = { id: 'owner-1', email: 'owner@example.com' };
  await service.addMeetingMember(user, 'meeting-1', 'member@example.com');
  assert.deepEqual(await service.listMeetingMembers(user, 'meeting-1'), [{
    userId: 'member@example.com', email: 'member@example.com', ownerUserId: 'owner-1', meetingId: 'meeting-1'
  }]);
  await service.removeMeetingMember(user, 'meeting-1', 'member@example.com');
  assert.deepEqual(await service.listMeetingMembers(user, 'meeting-1'), []);
});
