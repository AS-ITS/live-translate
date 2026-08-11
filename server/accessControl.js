import crypto from 'node:crypto';

export const ACCESS_CONTROL_ERRORS = Object.freeze({
  auth_required: { status: 401, message: 'Access token is required.' },
  auth_invalid: { status: 401, message: 'Access token is invalid.' },
  auth_not_configured: { status: 503, message: 'Access gate is not configured.' }
});

export function createAccessControl({ env = process.env } = {}) {
  return Object.freeze({
    isConfigured() {
      return typeof env.DEMO_ACCESS_TOKEN === 'string' && env.DEMO_ACCESS_TOKEN.length > 0;
    },

    validateRequest(req) {
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
      const legacyToken = typeof req?.headers?.['x-demo-access-token'] === 'string'
        ? req.headers['x-demo-access-token']
        : '';
      const candidate = bearerToken || legacyToken;
      if (!candidate) throw accessError('auth_required');

      const expected = Buffer.from(env.DEMO_ACCESS_TOKEN);
      const actual = Buffer.from(candidate);
      if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
        throw accessError('auth_invalid');
      }
    }
  });
}

export function accessError(code) {
  const template = ACCESS_CONTROL_ERRORS[code] || ACCESS_CONTROL_ERRORS.auth_invalid;
  const error = new Error(template.message);
  error.code = code;
  error.status = template.status;
  return error;
}
