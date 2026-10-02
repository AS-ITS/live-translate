import assert from 'node:assert/strict';
import test from 'node:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createAccessControl } from '../../server/accessControl.js';

const env = {
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_JWKS_URL: 'https://project.supabase.co/auth/v1/.well-known/jwks.json',
  AUTH_ALLOWED_EMAIL_DOMAINS: 'example.com',
};

async function createFixture() {
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'current-key';
  const token = (email = 'a@example.com', expiration = '1h') => new SignJWT({
    role: 'authenticated',
    email,
  }).setProtectedHeader({ alg: 'ES256', typ: 'JWT', kid: jwk.kid })
    .setSubject('00000000-0000-0000-0000-000000000001')
    .setIssuer(`${env.SUPABASE_URL}/auth/v1`)
    .setAudience('authenticated')
    .setExpirationTime(expiration)
    .sign(privateKey);
  return { jwk, token };
}

test('Supabase JWKS auth validates claims and Workspace domain', async () => {
  const { jwk, token } = await createFixture();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: [jwk] }), {
    headers: { 'content-type': 'application/json' },
  });
  try {
    const access = createAccessControl({ env });
    const valid = await token();
    assert.equal((await access.validateRequest({ headers: { authorization: `Bearer ${valid}` } })).email, 'a@example.com');

    const forbidden = await token('a@other.com');
    await assert.rejects(
      access.validateRequest({ headers: { authorization: `Bearer ${forbidden}` } }),
      { code: 'auth_forbidden', status: 403 },
    );

    const expired = await token('a@example.com', '-1s');
    await assert.rejects(
      access.validateRequest({ headers: { authorization: `Bearer ${expired}` } }),
      { code: 'auth_invalid', status: 401 },
    );

    const noAllowlist = createAccessControl({ env: { ...env, AUTH_ALLOWED_EMAIL_DOMAINS: '' } });
    await assert.rejects(
      noAllowlist.validateRequest({ headers: { authorization: `Bearer ${valid}` } }),
      { code: 'auth_forbidden', status: 403 },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
