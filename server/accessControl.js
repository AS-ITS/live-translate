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
      return Boolean(jwks && env.SUPABASE_URL);
    },

    async validateRequest(req) {
      if (!this.isConfigured()) {
        if (env.NODE_ENV === 'production') throw accessError('auth_not_configured');
        return;
      }

      const bearerToken = getBearerToken(req);
      if (!bearerToken) throw accessError('auth_required');

      let claims;
      try {
        ({ payload: claims } = await jwtVerify(bearerToken, jwks, {
          issuer: `${String(env.SUPABASE_URL).replace(/\/$/, '')}/auth/v1`,
          audience: 'authenticated',
        }));
      } catch {
        throw accessError('auth_invalid');
      }

      const email = claims.email || claims.user_metadata?.email;
      if (claims.role !== 'authenticated' || typeof claims.sub !== 'string' || !email || !isAllowedEmailDomain(email, env.AUTH_ALLOWED_EMAIL_DOMAINS)) {
        throw accessError('auth_forbidden');
      }
      return Object.freeze({ id: claims.sub, email, claims });
    },
  });
}

export function getBearerToken(req) {
  const authorization = typeof req?.headers?.authorization === 'string' ? req.headers.authorization : '';
  return authorization.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : '';
}

export function isAllowedEmailDomain(email, configuredDomains) {
  const domains = String(configuredDomains || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (domains.length === 0) return false;
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const separator = normalizedEmail.indexOf('@');
  if (separator <= 0 || separator !== normalizedEmail.lastIndexOf('@') || separator === normalizedEmail.length - 1) return false;
  const domain = normalizedEmail.slice(separator + 1);
  return domains.includes(domain);
}

export function accessError(code) {
  const template = ACCESS_CONTROL_ERRORS[code] || ACCESS_CONTROL_ERRORS.auth_invalid;
  const error = new Error(template.message);
  error.code = code;
  error.status = template.status;
  return error;
}
