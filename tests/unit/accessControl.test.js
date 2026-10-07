import assert from 'node:assert/strict';
import test from 'node:test';
import { createAccessControl, isAllowedEmailDomain } from '../../server/accessControl.js';

function request(headers = {}) {
  return { headers };
}

test('access control requires Supabase configuration in production', async () => {
  const access = createAccessControl({ env: { NODE_ENV: 'production', DEMO_ACCESS_TOKEN: 'secret-token' } });
  assert.equal(access.isConfigured(), false);
  await assert.rejects(access.validateRequest(request()), { code: 'auth_not_configured', status: 503 });
});

test('access control does not accept demo token headers', async () => {
  const access = createAccessControl({ env: {
    NODE_ENV: 'production',
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_JWKS_URL: 'https://project.supabase.co/auth/v1/.well-known/jwks.json',
    AUTH_ALLOWED_EMAIL_DOMAINS: 'example.com',
    DEMO_ACCESS_TOKEN: 'secret-token',
  } });
  await assert.rejects(access.validateRequest(request({ 'x-demo-access-token': 'secret-token' })), { code: 'auth_required', status: 401 });
  await assert.rejects(access.validateRequest(request({ authorization: 'Bearer wrong' })), { code: 'auth_invalid', status: 401 });
});

test('unconfigured non-production access remains available to local test adapters', async () => {
  await assert.doesNotReject(createAccessControl({ env: { NODE_ENV: 'test' } }).validateRequest(request()));
});

test('email domain allowlist uses normalized exact matches and fails closed', () => {
  assert.equal(isAllowedEmailDomain(' Person@Example.COM ', ' example.com,other.example '), true);
  assert.equal(isAllowedEmailDomain('person@sub.example.com', 'example.com'), false);
  assert.equal(isAllowedEmailDomain('person@example.com.evil', 'example.com'), false);
  assert.equal(isAllowedEmailDomain('person@evil-example.com', 'example.com'), false);
  assert.equal(isAllowedEmailDomain('person@evil.com@example.com', 'example.com'), false);
  assert.equal(isAllowedEmailDomain('person@example.com', ''), false);
});
