export function createProfileService({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const localMemberships = new Map();
  return {
    async getProfile(user) {
      if (!user?.id) throw new Error('Authenticated user identity required.');
      const fallback = {
        id: user.id,
        email: user.email,
        fullName: user.claims?.user_metadata?.full_name || null,
        avatarUrl: user.claims?.user_metadata?.avatar_url || null,
        role: user.role || 'member',
        status: user.status || 'active',
      };
      if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) return fallback;
      const response = await fetchImpl(`${env.SUPABASE_URL.replace(/\/$/u, '')}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=id,email,full_name,avatar_url,role,status,created_at,updated_at`, {
        headers: { apikey: env.SUPABASE_SECRET_KEY, Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}` },
      });
      if (!response.ok) throw new Error('Profile service unavailable.');
      const profile = (await response.json())[0];
      if (!profile) return fallback;
      return { ...profile, fullName: profile.full_name, avatarUrl: profile.avatar_url, role: profile.role || 'member', status: profile.status || 'active' };
    },
 async canRecordMeeting(user, meetingId) {
 if (!user?.id || !meetingId) return false;
 const profile = await this.getProfile(user);
 if (profile.status !== 'active') return false;
 if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) {
 return Boolean((localMemberships.get(meetingId) || []).some((item) => item.userId === user.id));
 }
 const rows = await restRequest(`/rest/v1/meeting_members?meeting_id=eq.${encodeURIComponent(meetingId)}&user_id=eq.${encodeURIComponent(user.id)}&select=user_id`, 'GET');
 return rows.length > 0;
 },
 async getMeetingOwner(meetingId) {
 if (!meetingId) return null;
 if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) return (localMemberships.get(meetingId) || [])[0]?.ownerUserId || null;
 const rows = await restRequest(`/rest/v1/meeting_members?meeting_id=eq.${encodeURIComponent(meetingId)}&select=owner_user_id&limit=1`, 'GET');
 return rows[0]?.owner_user_id || null;
 },
 async listMeetingMembers(user, meetingId) {
      if (!user?.id) throw accountError('auth_required');
      if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) {
        return [...(localMemberships.get(meetingId) || [])];
      }
      const response = await restRequest(`/rest/v1/meeting_members?meeting_id=eq.${encodeURIComponent(meetingId)}&select=user_id,owner_user_id,created_at`, 'GET');
      return response.map((item) => ({ userId: item.user_id, ownerUserId: item.owner_user_id, meetingId, createdAt: item.created_at }));
    },
    async addMeetingMember(user, meetingId, email) {
      if (!user?.id || !email) throw accountError('invalid_request');
      if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) {
        const members = localMemberships.get(meetingId) || [];
        const member = { userId: email.toLowerCase(), email: email.toLowerCase(), ownerUserId: user.id, meetingId };
        if (!members.some((item) => item.email === member.email)) localMemberships.set(meetingId, [...members, member]);
        return member;
      }
      const profiles = await restRequest(`/rest/v1/profiles?email=eq.${encodeURIComponent(email)}&select=id,email,status`, 'GET');
      const target = profiles[0];
      if (!target || target.status === 'disabled') throw accountError('auth_forbidden');
      const rows = await restRequest('/rest/v1/meeting_members', 'POST', [{ owner_user_id: user.id, meeting_id: meetingId, user_id: target.id }]);
      return rows[0]
        ? { userId: rows[0].user_id, ownerUserId: rows[0].owner_user_id, meetingId, createdAt: rows[0].created_at, email: target.email }
        : { userId: target.id, email: target.email, ownerUserId: user.id, meetingId };
    },
    async removeMeetingMember(user, meetingId, memberId) {
      if (!user?.id || !memberId) throw accountError('invalid_request');
      if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) {
        const members = localMemberships.get(meetingId) || [];
        localMemberships.set(meetingId, members.filter((item) => item.userId !== memberId));
        return true;
      }
      await restRequest(`/rest/v1/meeting_members?meeting_id=eq.${encodeURIComponent(meetingId)}&user_id=eq.${encodeURIComponent(memberId)}&owner_user_id=eq.${encodeURIComponent(user.id)}`, 'DELETE');
      return true;
    },
  };

  async function restRequest(path, method, body) {
    const response = await fetchImpl(`${env.SUPABASE_URL.replace(/\/$/u, '')}${path}`, {
      method,
      headers: { apikey: env.SUPABASE_SECRET_KEY, Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`, Prefer: 'return=representation', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    if (!response.ok) throw accountError(response.status === 404 ? 'meeting_not_found' : 'supabase_request_failed');
    return response.status === 204 ? [] : response.json();
  }
}

function accountError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
