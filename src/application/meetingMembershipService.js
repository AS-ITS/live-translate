const ACTIVE = 'active';

export function createMeetingMembershipService({ membershipRepository, profileRepository, meetingRepository, sessionRepository } = {}) {
  if (!membershipRepository) throw new TypeError('membershipRepository is required.');

  return Object.freeze({
    async canRecord(meetingId, userId) {
      if (!meetingId || !userId) return false;
      const profile = typeof profileRepository?.getProfile === 'function'
        ? await profileRepository.getProfile(userId)
        : null;
      if (profile && profile.status !== ACTIVE) return false;
      if (profile?.role === 'super_admin') return true;
      const ownerUserId = await ownerFor(meetingId);
      if (ownerUserId === userId) return true;
      const membership = await membershipRepository.find({ meetingId, userId });
    return Boolean(membership && membership.canRecord !== false);
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

    async canAccessMeeting(meetingId, actor) {
      if (!meetingId || !actor?.id) return false;
      const profile = typeof profileRepository?.getProfile === 'function'
        ? await profileRepository.getProfile(actor.id)
        : actor;
      if (!profile || profile.status !== ACTIVE) return false;
      if (profile.role === 'super_admin') return true;
      if ((await ownerFor(meetingId)) === actor.id) return true;
      return Boolean(await membershipRepository.find({ meetingId, userId: actor.id }));
    },

    async getMeetingOwner(meetingId) {
      return ownerFor(meetingId);
    },

    async getSessionOwner(sessionId) {
      if (!sessionId) return null;
      if (typeof sessionRepository?.getSessionOwner === 'function') {
        return sessionRepository.getSessionOwner(sessionId);
      }
      if (typeof sessionRepository?.getSessionRecord !== 'function') return null;
      const result = await sessionRepository.getSessionRecord(sessionId);
      const record = result?.sessionRecord || result;
      if (!record) return null;
      return { meetingId: record.meetingId, ownerUserId: record.ownerUserId };
    },

    async list(meetingId, actor) {
      if (actor && !await this.canManage(meetingId, actor)) {
        const error = new Error('Access is not allowed.');
        error.code = 'auth_forbidden';
        error.status = 403;
        throw error;
      }
      return membershipRepository.list({ meetingId, actor });
    },
  });

  async function ownerFor(meetingId) {
    if (typeof membershipRepository.getMeetingOwner === 'function') {
      const ownerUserId = await membershipRepository.getMeetingOwner(meetingId);
      if (ownerUserId) return ownerUserId;
    }
    if (typeof meetingRepository?.getMeeting === 'function') {
      const meeting = await meetingRepository.getMeeting(meetingId);
      const ownerUserId = meeting?.ownerUserId || meeting?.owner_user_id;
      if (ownerUserId) return ownerUserId;
    }
    const membership = await membershipRepository.find({ meetingId, owner: true });
    return membership?.ownerUserId || membership?.owner_user_id || null;
  }
}
