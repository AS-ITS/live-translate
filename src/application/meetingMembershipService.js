const ACTIVE = 'active';

export function createMeetingMembershipService({ membershipRepository, profileRepository } = {}) {
  if (!membershipRepository) throw new TypeError('membershipRepository is required.');

  return Object.freeze({
    async canRecord(meetingId, userId) {
      if (!meetingId || !userId) return false;
      const profile = typeof profileRepository?.getProfile === 'function'
        ? await profileRepository.getProfile(userId)
        : null;
      if (profile && profile.status !== ACTIVE) return false;
      const membership = await membershipRepository.find({ meetingId, userId });
      return Boolean(membership);
    },

    async list(meetingId) {
      return membershipRepository.list({ meetingId });
    },
  });
}

