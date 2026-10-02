import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createRequestHandler, resolveAllowedOrigin, resolveAllowedOrigins } from '../../server/index.js';
import { createAccessControl } from '../../server/accessControl.js';
import { createLiveToken } from '../../server/tokenService.js';

function makeRequest(handler, body, { user = { id: 'recorder-1', role: 'member', status: 'active' }, canRecord = true, headers } = {}) {
  const req = Readable.from([JSON.stringify(body)]);
  req.method = 'POST';
  req.url = '/api/live-token';
  req.headers = headers || { authorization: user ? 'Bearer signed-token' : '' };
  req.socket = { remoteAddress: '127.0.0.1' };
  const response = { statusCode: 0, headers: {}, body: '', writeHead(status, headers) { this.statusCode = status; this.headers = headers; }, end(value = '') { this.body = value; } };
  return handler(req, response).then(() => ({ status: response.statusCode, headers: response.headers, body: JSON.parse(response.body || '{}') }));
}

function handlerFor({ user = { id: 'recorder-1', role: 'member', status: 'active' }, canRecord = true, logs = [] } = {}) {
  return createRequestHandler({
    accessControl: { validateRequest: async () => user },
    profileService: { async getProfile() { return { role: user?.role || 'member', status: user?.status || 'active' }; } },
    meetingMembershipService: { async canRecord() { return canRecord; }, async getMeetingOwner() { return canRecord ? 'owner-1' : null; } },
    sessionReadController: { async getSession() { return { sessionRecord: { meetingId: 'meeting-1', targetLanguageCode: 'en', sourceLanguageCode: 'zh-Hant' } }; } },
    requestLogger: (event) => logs.push(event),
    liveTokenCreator: async (body, options) => ({ token: 'ephemeral-token', expiresAt: '2026-09-23T00:30:00.000Z', receivedBody: body, receivedKey: options.apiKey })
  });
}

const validBody = { meetingId: 'meeting-1', sessionId: 'session-1', targetLanguageCode: 'en', geminiApiKey: 'request-only-secret' };

test('live-token fails closed for unauthenticated and viewer requests', async () => {
  const unauthenticated = await makeRequest(handlerFor({ user: null }), validBody, { user: null });
  assert.equal(unauthenticated.status, 401);

  const viewer = await makeRequest(handlerFor({ canRecord: false }), validBody);
  assert.equal(viewer.status, 403);
  assert.equal(viewer.body.error.code, 'recorder_forbidden');
});

test('live-token uses only request key and redacts secrets from response and logs', async () => {
  const logs = [];
  const handler = handlerFor({ logs });
  const result = await makeRequest(handler, validBody);

  assert.equal(result.status, 200);
  assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.equal(result.body.token, 'ephemeral-token');
  assert.equal(result.body.receivedKey, undefined);
  assert.doesNotMatch(JSON.stringify(result.body), /request-only-secret|signed-token/);
  assert.doesNotMatch(JSON.stringify(logs), /request-only-secret|ephemeral-token|signed-token/);
});

test('live-token trims the request key before invoking the provider', async () => {
  let receivedKey;
  const handler = createRequestHandler({
    accessControl: { validateRequest: async () => ({ id: 'recorder-1', role: 'member', status: 'active' }) },
    profileService: { async getProfile() { return { role: 'member', status: 'active' }; } },
    meetingMembershipService: { async canRecord() { return true; }, async getMeetingOwner() { return 'owner-1'; } },
    sessionReadController: { async getSession() { return { sessionRecord: { meetingId: 'meeting-1' } }; } },
    liveTokenCreator: async (_body, options) => { receivedKey = options.apiKey; return { token: 'ephemeral-token' }; }
  });

  const result = await makeRequest(handler, { ...validBody, geminiApiKey: '  request-only-secret\n' });
  assert.equal(result.status, 200);
  assert.equal(receivedKey, 'request-only-secret');
});

test('live-token records safe provider diagnostics for Google 403 and returns 502', async () => {
  const logs = [];
  const failingHandler = createRequestHandler({
    accessControl: { validateRequest: async () => ({ id: 'recorder-1', role: 'member', status: 'active' }) },
    profileService: { async getProfile() { return { role: 'member', status: 'active' }; } },
    meetingMembershipService: { async canRecord() { return true; }, async getMeetingOwner() { return 'owner-1'; } },
    sessionReadController: { async getSession() { return { sessionRecord: { meetingId: 'meeting-1' } }; } },
    requestLogger: (event) => logs.push(event),
    liveTokenCreator: async () => {
      const error = new Error('Failed to create Gemini ephemeral token');
      error.status = 502;
      error.providerDiagnostic = { status: 403, code: 'PERMISSION_DENIED', category: 'permission_api_unavailable', message: 'key=AIzaSyDoNotLogThis' };
      throw error;
    }
  });

  const result = await makeRequest(failingHandler, validBody);
  assert.equal(result.status, 502);
  assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.doesNotMatch(JSON.stringify(result.body), /request-only-secret|signed-token|AIzaSyDoNotLogThis/);
  const diagnostic = logs.find((event) => event.event === 'gemini_token_provider_failure');
  assert.equal(diagnostic.stage, 'google_auth_token_request');
  assert.equal(diagnostic.hasSupabaseAccessToken, true);
  assert.equal(diagnostic.status, 403);
  assert.equal(diagnostic.code, 'PERMISSION_DENIED');
  assert.equal(diagnostic.tokenCreated, false);
  assert.doesNotMatch(JSON.stringify(logs), /AIzaSyDoNotLogThis|request-only-secret|signed-token/);
});

test('live-token rejects a missing request key without invoking creator', async () => {
  let creatorCalls = 0;
  const handler = createRequestHandler({
    accessControl: { validateRequest: async () => ({ id: 'recorder-1', role: 'member', status: 'active' }) },
    profileService: { async getProfile() { return { role: 'member', status: 'active' }; } },
    meetingMembershipService: { async canRecord() { return true; }, async getMeetingOwner() { return 'owner-1'; } },
    sessionReadController: { async getSession() { return { sessionRecord: { meetingId: 'meeting-1' } }; } },
    liveTokenCreator: async () => { creatorCalls += 1; return { token: 'unexpected' }; }
  });
  const result = await makeRequest(handler, { ...validBody, geminiApiKey: undefined });
  assert.equal(result.status, 500);
  assert.equal(creatorCalls, 0);
});

test('live-token rejects an expired Supabase JWT as auth_invalid', async () => {
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'expired-key';
  const token = await new SignJWT({ role: 'authenticated', email: 'recorder@example.com' })
    .setProtectedHeader({ alg: 'ES256', kid: jwk.kid })
    .setSubject('recorder-1')
    .setIssuer('https://project.supabase.co/auth/v1')
    .setAudience('authenticated')
    .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
    .sign(privateKey);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: [jwk] }), { headers: { 'content-type': 'application/json' } });
  try {
    const handler = createRequestHandler({
      accessControl: createAccessControl({ env: {
        SUPABASE_URL: 'https://project.supabase.co',
        SUPABASE_JWKS_URL: 'https://project.supabase.co/auth/v1/.well-known/jwks.json',
        AUTH_ALLOWED_EMAIL_DOMAINS: 'example.com'
      } }),
      profileService: { async getProfile() { return { role: 'member', status: 'active' }; } },
      meetingMembershipService: { async canRecord() { return true; }, async getMeetingOwner() { return 'owner-1'; } },
      sessionReadController: { async getSession() { return { sessionRecord: { meetingId: 'meeting-1' } }; } },
      liveTokenCreator: async () => ({ token: 'unexpected' })
    });
    const result = await makeRequest(handler, validBody, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(result.status, 401);
    assert.equal(result.body.error.code, 'auth_invalid');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('live-token keeps users, keys, and tokens isolated across handlers', async () => {
  const makeIsolatedHandler = (userId) => createRequestHandler({
    accessControl: { validateRequest: async () => ({ id: userId, role: 'member', status: 'active' }) },
    profileService: { async getProfile() { return { role: 'member', status: 'active' }; } },
    meetingMembershipService: { async canRecord() { return true; }, async getMeetingOwner() { return userId; } },
    sessionReadController: { async getSession() { return { sessionRecord: { meetingId: 'meeting-1' } }; } },
    liveTokenCreator: async (_body, { apiKey }) => ({ token: `${userId}:${apiKey}` })
  });
  const first = await makeRequest(makeIsolatedHandler('user-a'), { ...validBody, geminiApiKey: 'key-a' });
  const second = await makeRequest(makeIsolatedHandler('user-b'), { ...validBody, geminiApiKey: 'key-b' });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(first.body.token, 'user-a:key-a');
  assert.equal(second.body.token, 'user-b:key-b');
  assert.notEqual(first.body.token, second.body.token);
});

test('new handler instance cannot recover a previous request key from memory', async () => {
  let creatorCalls = 0;
  const makeHandler = () => createRequestHandler({
    accessControl: { validateRequest: async () => ({ id: 'recorder-1', role: 'member', status: 'active' }) },
    profileService: { async getProfile() { return { role: 'member', status: 'active' }; } },
    meetingMembershipService: { async canRecord() { return true; }, async getMeetingOwner() { return 'owner-1'; } },
    sessionReadController: { async getSession() { return { sessionRecord: { meetingId: 'meeting-1' } }; } },
    liveTokenCreator: async () => { creatorCalls += 1; return { token: 'unexpected' }; }
  });
  const first = await makeRequest(makeHandler(), validBody);
  const second = await makeRequest(makeHandler(), { ...validBody, geminiApiKey: undefined });
  assert.equal(first.status, 200);
  assert.equal(second.status, 500);
  assert.equal(creatorCalls, 1);
});

test('origin resolver preserves explicit APP_ORIGIN for Preview and Production', () => {
  assert.equal(resolveAllowedOrigin({ NODE_ENV: 'production', APP_ORIGIN: 'https://preview.example', VERCEL_URL: 'preview.vercel.app' }), 'https://preview.example');
  assert.equal(resolveAllowedOrigin({ NODE_ENV: 'production', VERCEL_URL: 'prod.vercel.app' }), 'https://prod.vercel.app');
  assert.equal(resolveAllowedOrigin({ NODE_ENV: 'development', APP_ORIGIN: 'http://localhost:5173', dev_frontend_origin: '' }), 'http://localhost:5173');
});

test('origin resolver uses exact production and preview allowlists', () => {
  assert.deepEqual(
    [...resolveAllowedOrigins({
      NODE_ENV: 'production',
      VERCEL_ENV: 'preview',
      APP_ORIGIN: 'https://branch.example/app/?source=preview',
      VERCEL_URL: 'immutable.vercel.app',
      VERCEL_BRANCH_URL: 'branch.vercel.app'
    })],
    ['https://branch.example', 'https://immutable.vercel.app', 'https://branch.vercel.app']
  );
  assert.deepEqual(
    [...resolveAllowedOrigins({
      NODE_ENV: 'production',
      VERCEL_ENV: 'production',
      APP_ORIGIN: 'https://app.example/',
      VERCEL_URL: 'immutable.vercel.app',
      VERCEL_BRANCH_URL: 'branch.vercel.app'
    })],
    ['https://app.example']
  );
});

test('malformed production APP_ORIGIN fails closed without Vercel or Host fallback', () => {
  for (const appOrigin of [
    'not-a-valid-origin',
    'ftp://live.example.com',
    'https://user:password@live.example.com',
    'https://'
  ]) {
    const allowedOrigins = resolveAllowedOrigins({
      NODE_ENV: 'production',
      VERCEL_ENV: 'production',
      APP_ORIGIN: appOrigin,
      VERCEL_URL: 'deployment-project.vercel.app',
      VERCEL_BRANCH_URL: 'project-git-feature-user.vercel.app',
      HOST: 'attacker-controlled.example'
    });

    assert.deepEqual([...allowedOrigins], []);
    assert.equal(allowedOrigins.has('https://evil.example.com'), false);
    assert.equal(allowedOrigins.has('https://unrelated-project.vercel.app'), false);
    assert.equal(allowedOrigins.has('https://deployment-project.vercel.app'), false);
    assert.equal(allowedOrigins.has('https://project-git-feature-user.vercel.app'), false);
    assert.equal(allowedOrigins.has('https://attacker-controlled.example'), false);
  }
});

test('transcription provider 403 diagnostic contains the actual model and API version', async () => {
  const client = { authTokens: { async create() { const error = new Error('permission denied'); error.status = 403; error.code = 'PERMISSION_DENIED'; throw error; } } };
  await assert.rejects(() => createLiveToken({ mode: 'transcription', targetLanguageCode: 'en' }, {
    apiKey: 'request-only-secret',
    client,
    liveTranscriptionModel: 'gemini-transcribe-custom'
  }), (error) => {
    assert.equal(error.status, 502);
    assert.equal(error.providerDiagnostic.model, 'gemini-transcribe-custom');
    assert.equal(error.providerDiagnostic.apiVersion, 'v1beta');
    assert.doesNotMatch(JSON.stringify(error.providerDiagnostic), /request-only-secret/);
    return true;
  });
});
