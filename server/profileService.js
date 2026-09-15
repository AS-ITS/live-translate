import { createAuditLogService } from './auditLogService.js';

export function createProfileService({ env = process.env, fetchImpl = globalThis.fetch, auditLogService = createAuditLogService({ env, fetchImpl }) } = {}) {
  const localMemberships = new Map();
  const localMeetingOwners = new Map();
  const cloud = () => env.SUPABASE_URL && env.SUPABASE_SECRET_KEY;
  return {
    async getProfile(user) {
      if (!user?.id) throw new Error('Authenticated user identity required.');
      const fallback = { id: user.id, email: user.email, fullName: user.claims?.user_metadata?.full_name || null, avatarUrl: user.claims?.user_metadata?.avatar_url || null, role: user.role || 'member', status: user.status || 'active' };
      if (!cloud()) return fallback;
      const rows = await restRequest(`/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=id,email,full_name,avatar_url,role,status,created_at,updated_at`);
      const profile = rows[0];
      return profile ? { ...profile, fullName: profile.full_name, avatarUrl: profile.avatar_url, role: profile.role || 'member', status: profile.status || 'active' } : fallback;
    },
    async findMeetingMembership(meetingId, userId) {
      if (!meetingId || !userId) return null;
      if (!cloud()) return (localMemberships.get(meetingId) || []).find((item) => item.userId === userId) || null;
      const rows = await restRequest(`/rest/v1/meeting_members?meeting_id=eq.${encodeURIComponent(meetingId)}&user_id=eq.${encodeURIComponent(userId)}&select=user_id,owner_user_id,created_at,can_record`);
      return rows[0] || null;
    },
    async canRecordMeeting(user, meetingId) {
      if (!user?.id || !meetingId) return false;
      const profile = await this.getProfile(user);
      if (profile.status !== 'active') return false;
      if (!cloud()) return localMeetingOwners.get(meetingId) === user.id || Boolean((localMemberships.get(meetingId) || []).some((item) => item.userId === user.id && item.canRecord !== false));
      const rows = await restRequest(`/rest/v1/meeting_members?meeting_id=eq.${encodeURIComponent(meetingId)}&user_id=eq.${encodeURIComponent(user.id)}&select=user_id,can_record`);
      return (rows.length > 0 && rows[0].can_record !== false) || (await this.getMeetingOwner(meetingId)) === user.id;
    },
    async getMeetingOwner(meetingId) {
      if (!meetingId) return null;
      if (!cloud()) return localMeetingOwners.get(meetingId) || (localMemberships.get(meetingId) || [])[0]?.ownerUserId || null;
      const rows = await restRequest(`/rest/v1/meetings?id=eq.${encodeURIComponent(meetingId)}&select=owner_user_id`);
      return rows[0]?.owner_user_id || null;
    },
    async canManageMeeting(user, meetingId) {
      if (!user?.id || !meetingId) return false;
      const profile = await this.getProfile(user);
      if (profile.status !== 'active') return false;
      return profile.role === 'super_admin' || (await this.getMeetingOwner(meetingId)) === user.id;
    },
    async getSessionOwner(sessionId) {
      if (!sessionId || !cloud()) return null;
      const rows = await restRequest(`/rest/v1/sessions?id=eq.${encodeURIComponent(sessionId)}&select=meeting_id,owner_user_id`);
      return rows[0] ? { meetingId: rows[0].meeting_id, ownerUserId: rows[0].owner_user_id } : null;
    },
    async listMeetingMembers(user, meetingId) {
      if (!user?.id) throw accountError('auth_required');
      if (!await this.canManageMeeting(user, meetingId)) throw accountError('auth_forbidden');
      if (!cloud()) return [...(localMemberships.get(meetingId) || [])];
      const rows = await restRequest(`/rest/v1/meeting_members?meeting_id=eq.${encodeURIComponent(meetingId)}&select=user_id,owner_user_id,created_at,can_record`);
      return rows.map((item) => ({ userId: item.user_id, ownerUserId: item.owner_user_id, meetingId, createdAt: item.created_at, canRecord: item.can_record !== false }));
    },
    async addMeetingMember(user, meetingId, email, requestId) {
      if (!user?.id || !email) throw accountError('invalid_request');
      if (!await this.canManageMeeting(user, meetingId) && (await this.getMeetingOwner(meetingId)) !== null) throw accountError('auth_forbidden');
      if (!cloud()) {
        if (!localMeetingOwners.has(meetingId)) localMeetingOwners.set(meetingId, user.id);
        if (localMeetingOwners.get(meetingId) !== user.id) throw accountError('auth_forbidden');
        const members = localMemberships.get(meetingId) || [];
        const member = { userId: email.toLowerCase(), email: email.toLowerCase(), ownerUserId: user.id, meetingId };
        Object.defineProperty(member, 'canRecord', { value: true, writable: true, enumerable: false });
        if (!members.some((item) => item.email === member.email)) localMemberships.set(meetingId, [...members, member]);
        await auditLogService?.record({ actor_user_id: user.id, target_user_id: member.userId, target_meeting_id: meetingId, request_id: requestId, action: 'member_invited', result: 'success' });
        return member;
      }
      const profiles = await restRequest(`/rest/v1/profiles?email=eq.${encodeURIComponent(email)}&select=id,email,status`);
      const target = profiles[0];
      if (!target || target.status === 'disabled') throw accountError('auth_forbidden');
      const rows = await restRequest('/rest/v1/meeting_members', 'POST', [{ owner_user_id: user.id, meeting_id: meetingId, user_id: target.id, can_record: true }]);
      const row = rows[0] || { user_id: target.id, owner_user_id: user.id };
      const result = { userId: row.user_id, ownerUserId: row.owner_user_id, meetingId, createdAt: row.created_at, canRecord: row.can_record !== false, email: target.email };
      await auditLogService?.record({ actor_user_id: user.id, target_user_id: result.userId, target_meeting_id: meetingId, request_id: requestId, action: 'member_invited', result: 'success' });
      return result;
    },
    async removeMeetingMember(user, meetingId, memberId, requestId) {
      if (!user?.id || !memberId) throw accountError('invalid_request');
      if (!await this.canManageMeeting(user, meetingId)) throw accountError('auth_forbidden');
      if (!cloud()) localMemberships.set(meetingId, (localMemberships.get(meetingId) || []).filter((item) => item.userId !== memberId));
      else await restRequest(`/rest/v1/meeting_members?meeting_id=eq.${encodeURIComponent(meetingId)}&user_id=eq.${encodeURIComponent(memberId)}&owner_user_id=eq.${encodeURIComponent(user.id)}`, 'DELETE');
      await auditLogService?.record({ actor_user_id: user.id, target_user_id: memberId, target_meeting_id: meetingId, request_id: requestId, action: 'member_removed', result: 'success' });
      return true;
    },
    async updateMeetingMemberRecording(user, meetingId, memberId, canRecord) {
      if (!user?.id || !memberId || typeof canRecord !== 'boolean') throw accountError('invalid_request');
      if (!await this.canManageMeeting(user, meetingId)) throw accountError('auth_forbidden');
      if (!cloud()) {
        const member = (localMemberships.get(meetingId) || []).find((item) => item.userId === memberId);
        if (!member) throw accountError('account_not_found');
        member.canRecord = canRecord;
        return member;
      }
      const rows = await restRequest(`/rest/v1/meeting_members?meeting_id=eq.${encodeURIComponent(meetingId)}&user_id=eq.${encodeURIComponent(memberId)}&owner_user_id=eq.${encodeURIComponent(user.id)}`, 'PATCH', { can_record: canRecord });
      if (!rows[0]) throw accountError('account_not_found');
      return { userId: rows[0].user_id, ownerUserId: rows[0].owner_user_id, meetingId, createdAt: rows[0].created_at, canRecord: rows[0].can_record !== false };
    }
  };

  async function restRequest(path, method = 'GET', body) {
    const response = await fetchImpl(`${env.SUPABASE_URL.replace(/\/$/u, '')}${path}`, { method, headers: { apikey: env.SUPABASE_SECRET_KEY, Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`, Prefer: 'return=representation', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw accountError(response.status === 404 ? 'meeting_not_found' : 'supabase_request_failed');
    return response.status === 204 ? [] : response.json();
  }
}

function accountError(code) { const error = new Error(code); error.code = code; return error; }
