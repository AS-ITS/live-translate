import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { handleRequest } from '../../server/index.js';

function resetMock() {
  globalThis.__mockGoogleGenAI = {
    clients: [],
    tokenCreates: [],
    liveConnects: [],
    liveSessions: []
  };
  delete process.env.MOCK_GOOGLE_GENAI_AUTH_ERROR;
  delete process.env.MOCK_GOOGLE_GENAI_TOKEN_NAME;
}

async function request({ method = 'POST', url = '/api/live-token', body = '', headers = {} } = {}) {
  const req = Readable.from(body ? [body] : []);
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.socket = { remoteAddress: headers['x-forwarded-for'] || '127.0.0.1' };

  const response = {
    statusCode: null,
    headers: null,
    body: '',
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(nextBody = '') {
      this.body = nextBody;
    }
  };

  await handleRequest(req, response);

  return {
    status: response.statusCode,
    headers: response.headers,
    json: () => JSON.parse(response.body || '{}')
  };
}

async function postJson(body) {
  return request({ body: JSON.stringify(body) });
}

test.beforeEach(() => {
  resetMock();
});

test.afterEach(() => {
  resetMock();
  delete process.env.GEMINI_API_KEY;
  delete process.env.DEMO_ACCESS_TOKEN;
  delete process.env.RATE_LIMIT_MAX;
  delete process.env.RATE_LIMIT_WINDOW_MS;
  delete process.env.ALLOWED_ORIGIN;
});

test('POST /api/live-token returns an ephemeral token without calling real Gemini', async () => {
  process.env.GEMINI_API_KEY = 'test-api-key';
  process.env.MOCK_GOOGLE_GENAI_TOKEN_NAME = 'mock-token-name';

  const response = await postJson({
    targetLanguageCode: 'ja',
    echoTargetLanguage: false
  });
  const body = response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(response.headers['Referrer-Policy'], 'no-referrer');
  assert.equal(response.headers['X-Frame-Options'], 'DENY');
  assert.ok(response.headers['Content-Security-Policy']);
  assert.ok(response.headers['X-Request-Id']);
  assert.deepEqual(body, {
    token: 'mock-token-name',
    expiresAt: body.expiresAt
  });
  assert.match(body.expiresAt, /^\d{4}-\d{2}-\d{2}T/);

  assert.deepEqual(globalThis.__mockGoogleGenAI.clients[0].httpOptions, { apiVersion: 'v1alpha' });
  assert.equal(globalThis.__mockGoogleGenAI.tokenCreates[0].config.liveConnectConstraints.config.generationConfig.translationConfig.targetLanguageCode, 'ja');
});

test('POST /api/live-token rejects invalid language', async () => {
  process.env.GEMINI_API_KEY = 'test-api-key';

  const response = await postJson({ targetLanguageCode: 'xx' });
  const body = response.json();

  assert.equal(response.status, 400);
  assert.equal(body.error.code, 'unsupported_language');
  assert.equal(body.error.requestId, response.headers['X-Request-Id']);

  assert.equal(globalThis.__mockGoogleGenAI.tokenCreates.length, 0);
});

test('POST /api/live-token rejects requests when api key is missing', async () => {
  delete process.env.GEMINI_API_KEY;

  const response = await postJson({ targetLanguageCode: 'en' });
  const body = response.json();

  assert.equal(response.status, 500);
  assert.equal(body.error.code, 'server_misconfigured');
});

test('POST /api/live-token maps expired-token provider failures to error response', async () => {
  process.env.GEMINI_API_KEY = 'test-api-key';
  process.env.MOCK_GOOGLE_GENAI_AUTH_ERROR = 'expired token';

  const response = await postJson({ targetLanguageCode: 'en' });
  const body = response.json();

  assert.equal(response.status, 502);
  assert.equal(body.error.code, 'provider_unavailable');
});

test('POST /api/live-token returns structured error response for invalid JSON', async () => {
  process.env.GEMINI_API_KEY = 'test-api-key';

  const response = await request({ body: '{not-json' });
  const body = response.json();

  assert.equal(response.status, 400);
  assert.equal(body.error.code, 'invalid_json');
});

test('POST /api/live-token requires configured demo access token', async () => {
  process.env.GEMINI_API_KEY = 'test-api-key';
  process.env.DEMO_ACCESS_TOKEN = 'demo-secret';

  const missingResponse = await postJson({ targetLanguageCode: 'en' });
  assert.equal(missingResponse.status, 401);
  assert.equal(missingResponse.json().error.code, 'auth_required');

  const invalidResponse = await request({
    body: JSON.stringify({ targetLanguageCode: 'en' }),
    headers: { 'x-demo-access-token': 'wrong-secret' }
  });
  assert.equal(invalidResponse.status, 401);
  assert.equal(invalidResponse.json().error.code, 'auth_invalid');

  const validResponse = await request({
    body: JSON.stringify({ targetLanguageCode: 'en' }),
    headers: { authorization: 'Bearer demo-secret' }
  });
  assert.equal(validResponse.status, 200);
});

test('POST /api/live-token rejects disallowed origin', async () => {
  process.env.GEMINI_API_KEY = 'test-api-key';
  process.env.ALLOWED_ORIGIN = 'https://app.example.com';

  const response = await request({
    body: JSON.stringify({ targetLanguageCode: 'en' }),
    headers: { origin: 'https://evil.example.com' }
  });

  assert.equal(response.status, 403);
  assert.equal(response.json().error.code, 'invalid_origin');
});

test('POST /api/live-token applies IP-based rate limit', async () => {
  process.env.GEMINI_API_KEY = 'test-api-key';
  process.env.RATE_LIMIT_MAX = '1';
  process.env.RATE_LIMIT_WINDOW_MS = '60000';

  const headers = { 'x-forwarded-for': '203.0.113.10' };
  const firstResponse = await request({ body: JSON.stringify({ targetLanguageCode: 'en' }), headers });
  const secondResponse = await request({ body: JSON.stringify({ targetLanguageCode: 'en' }), headers });

  assert.equal(firstResponse.status, 200);
  assert.equal(secondResponse.status, 429);
  assert.equal(secondResponse.json().error.code, 'rate_limited');
});

test('GET /healthz and /readyz report service status', async () => {
  const healthResponse = await request({ method: 'GET', url: '/healthz' });
  assert.equal(healthResponse.status, 200);
  assert.deepEqual(healthResponse.json().ok, true);

  const notReadyResponse = await request({ method: 'GET', url: '/readyz' });
  assert.equal(notReadyResponse.status, 503);

  process.env.GEMINI_API_KEY = 'test-api-key';
  const readyResponse = await request({ method: 'GET', url: '/readyz' });
  assert.equal(readyResponse.status, 200);
});
