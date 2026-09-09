export function createProfileService({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  return {
    async getProfile(user) {
      if (!user?.id) throw new Error('Authenticated user identity is required.');
      if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) {
        return {
          id: user.id,
          email: user.email,
          fullName: user.claims?.user_metadata?.full_name || null,
          avatarUrl: user.claims?.user_metadata?.avatar_url || null,
        };
      }
      const response = await fetchImpl(`${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=id,email,full_name,avatar_url,created_at,updated_at`, {
        headers: {
          apikey: env.SUPABASE_SECRET_KEY,
          Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
        },
      });
      if (!response.ok) throw new Error('Profile service unavailable.');
      const profile = (await response.json())[0];
      return profile
        ? { ...profile, fullName: profile.full_name, avatarUrl: profile.avatar_url }
        : { id: user.id, email: user.email, fullName: null, avatarUrl: null };
    },
  };
}
