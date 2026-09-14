const ACTIVE = 'active';

export function createMeetingMembershipService({ membershipRepository, profileRepository, meetingRepository } = {}) {
  if (!membershipRepository) throw new TypeError('membershipRepository is required.');

  return Object.freeze({
    async canRecord(meetingId, userId) {
      if (!meetingId || !userId) return false;
      const profile = typeof profileRepository?.getProfile === 'function'
        ? await profileRepository.getProfile(userId)
        : null;
      if (profile && profile.status !== ACTIVE) return false;
      const ownerUserId = await ownerFor(meetingId);
      if (ownerUserId === userId) return true;
      const membership = await membershipRepository.find({ meetingId, userId });
      return Boolean(membership);
    },

    async canManage(meetingId, actor) {
      if (!meetingId || !actor?.id) return false;
      const profile = typeof profileRepository?.getProfile === 'function'
        ? await profileRepository.getProfile(actor.id)
        : actor;
      if (!profile || profile.status !== ACTIVE) return false;
      if (profile.role === 'super_admin') return true;
      return (await ownerFor(meetingId)) === actor.id;
    },

    async list(meetingId, actor) {
      if (actor && !await this.canManage(meetingId, actor)) {
        const error = new Error('Access is not allowed.');
        error.code = 'auth_forbidden';
        error.status = 403;
        throw error;
      }
      return membershipRepository.list({ meetingId });
    },
  });

  async function ownerFor(meetingId) {
    if (typeof meetingRepository?.getMeeting === 'function') {
      const meeting = await meetingRepository.getMeeting(meetingId);
      return meeting?.ownerUserId || meeting?.owner_user_id || null;
    }
    const membership = await membershipRepository.find({ meetingId, owner: true });
    return membership?.ownerUserId || membership?.owner_user_id || null;
  }
}
