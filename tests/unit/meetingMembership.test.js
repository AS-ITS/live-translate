import assert from 'node:assert/strict';
import test from 'node:test';
import { createMeetingMembershipService } from '../../src/application/meetingMembershipService.js';

test('meeting membership allows active members to record and rejects disabled members', async () => {
  const service = createMeetingMembershipService({
    profileRepository: { getProfile: async () => ({ status: 'active' }) },
    membershipRepository: { find: async ({ meetingId, userId }) => meetingId === 'meeting-1' && userId === 'member-1' ? { meetingId, userId } : null, list: async () => [] }
  });
  assert.equal(await service.canRecord('meeting-1', 'member-1'), true);
  assert.equal(await service.canRecord('meeting-2', 'member-1'), false);
});

test('disabled account cannot record even when membership remains', async () => {
  const service = createMeetingMembershipService({
    profileRepository: { getProfile: async () => ({ status: 'disabled' }) },
    membershipRepository: { find: async () => ({ meetingId: 'meeting-1', userId: 'member-1' }), list: async () => [] }
  });
  assert.equal(await service.canRecord('meeting-1', 'member-1'), false);
});

