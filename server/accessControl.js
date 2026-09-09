import crypto from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';

export const ACCESS_CONTROL_ERRORS = Object.freeze({
  auth_required: { status: 401, message: 'Access token is required.' },
  auth_invalid: { status: 401, message: 'Access token is invalid.' },
  auth_forbidden: { status: 403, message: 'Access is not allowed.' },
  auth_not_configured: { status: 503, message: 'Access gate is not configured.' },
});

export function createAccessControl({ env = process.env } = {}) {
  let jwks = null;
  try {
    if (env.SUPABASE_JWKS_URL) jwks = createRemoteJWKSet(new URL(env.SUPABASE_JWKS_URL));
  } catch {
    jwks = null;
  }

  return Object.freeze({
    isConfigured() {
      return Boolean(jwks && env.SUPABASE_URL) ||
        (typeof env.DEMO_ACCESS_TOKEN === 'string' && env.DEMO_ACCESS_TOKEN.length > 0);
    },

    async validateRequest(req) {
      if (!this.isConfigured()) {
        if (env.NODE_ENV === 'production') throw accessError('auth_not_configured');
        return;
      }

      const authorization = typeof req?.headers?.authorization === 'string'
        ? req.headers.authorization
        : '';
      const bearerToken = authorization.startsWith('Bearer ')
        ? authorization.slice('Bearer '.length)
        : '';
      const demoToken = typeof env.DEMO_ACCESS_TOKEN === 'string' &&
        typeof req?.headers?.['x-demo-access-token'] === 'string'
        ? req.headers['x-demo-access-token']
        : '';
      const candidate = bearerToken || demoToken;
      if (!candidate) throw accessError('auth_required');

      if (jwks) {
        let claims;
        try {
          ({ payload: claims } = await jwtVerify(candidate, jwks, {
            issuer: `${String(env.SUPABASE_URL).replace(/\/$/, '')}/auth/v1`,
            audience: 'authenticated',
          }));
        } catch {
          throw accessError('auth_invalid');
        }

        const email = claims.email || claims.user_metadata?.email;
        if (claims.role !== 'authenticated' || typeof claims.sub !== 'string' ||
          !email || !isAllowedEmailDomain(email, env.AUTH_ALLOWED_EMAIL_DOMAINS)) {
          throw accessError('auth_forbidden');
        }
        return Object.freeze({ id: claims.sub, email, claims });
      }

      const expected = Buffer.from(env.DEMO_ACCESS_TOKEN || '');
      const actual = Buffer.from(candidate);
      if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
        throw accessError('auth_invalid');
      }
      return Object.freeze({ id: null, email: null, claims: { role: 'authenticated' } });
    },
  });
}

function isAllowedEmailDomain(email, configuredDomains) {
  const domains = String(configuredDomains || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (domains.length === 0) return false;
  const domain = String(email).split('@').pop()?.toLowerCase();
  return domains.includes(domain);
}

export function accessError(code) {
  const template = ACCESS_CONTROL_ERRORS[code] || ACCESS_CONTROL_ERRORS.auth_invalid;
  const error = new Error(template.message);
  error.code = code;
  error.status = template.status;
  return error;
}
