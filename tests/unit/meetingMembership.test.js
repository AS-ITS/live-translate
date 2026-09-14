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

test('membership list preserves actor for the repository authorization boundary', async () => {
  const calls = [];
  const actor = { id: 'owner-1', role: 'super_admin', status: 'active' };
  const service = createMeetingMembershipService({
    profileRepository: { getProfile: async () => actor },
    meetingRepository: { getMeeting: async () => ({ ownerUserId: 'owner-1' }) },
    membershipRepository: {
      find: async () => null,
      list: async (input) => { calls.push(input); return []; }
    }
  });

  await service.list('meeting-1', actor);
  assert.deepEqual(calls, [{ meetingId: 'meeting-1', actor }]);
});

test('session owner resolution returns the persisted resource scope', async () => {
  const service = createMeetingMembershipService({
    membershipRepository: { find: async () => null, list: async () => [] },
    sessionRepository: {
      getSessionRecord: async () => ({ sessionRecord: { meetingId: 'meeting-1', ownerUserId: 'owner-1' } })
    }
  });

  assert.deepEqual(await service.getSessionOwner('session-1'), {
    meetingId: 'meeting-1',
    ownerUserId: 'owner-1'
  });
});
