import { importJWK, SignJWT } from 'jose';

const DEFAULT_TTL_SECONDS = 5 * 60;

export function createViewerRealtimeTokenService({ env = process.env, clock = () => Date.now() } = {}) {
  const rawJwk = env.SUPABASE_REALTIME_SIGNING_PRIVATE_JWK;
  if (!rawJwk) return null;
  let jwk;
  try {
    jwk = JSON.parse(rawJwk);
  } catch {
    return null;
  }
  if (!jwk?.kty || !jwk?.alg || !jwk?.kid) return null;
  const signingJwk = Array.isArray(jwk.key_ops) && jwk.key_ops.includes('sign')
    ? { ...jwk, key_ops: ['sign'] }
    : jwk;
  const signingKey = importJWK(signingJwk, jwk.alg);
  const issuer = `${String(env.SUPABASE_URL || '').replace(/\/$/u, '')}/auth/v1`;

  return Object.freeze({
    async issue(share) {
      if (!share?.id || !share?.meetingId || share.role !== 'viewer') {
        const error = new Error('Viewer share is invalid.');
        error.code = 'meeting_share_invalid';
        error.status = 404;
        throw error;
      }
      const nowSeconds = Math.floor(clock() / 1000);
      const shareExpirySeconds = Number.isFinite(share.expiresAt)
        ? Math.floor(share.expiresAt / 1000)
        : Number.POSITIVE_INFINITY;
      const expiresAtSeconds = Math.min(nowSeconds + DEFAULT_TTL_SECONDS, shareExpirySeconds);
      if (expiresAtSeconds <= nowSeconds) {
        const error = new Error('Viewer share is expired.');
        error.code = 'meeting_share_invalid';
        error.status = 404;
        throw error;
      }
      const key = await signingKey;
      const accessToken = await new SignJWT({
        role: 'authenticated',
        meeting_id: share.meetingId,
        viewer_share_id: share.id
      })
        .setProtectedHeader({ alg: jwk.alg, kid: jwk.kid, typ: 'JWT' })
        .setSubject(share.id)
        .setAudience('authenticated')
        .setIssuer(issuer)
        .setIssuedAt(nowSeconds)
        .setExpirationTime(expiresAtSeconds)
        .sign(key);
      return {
        accessToken,
        expiresAt: expiresAtSeconds * 1000,
        channel: `meeting:${share.meetingId}`
      };
    }
  });
}
