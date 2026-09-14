export function createProfileService({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
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
  };
}
