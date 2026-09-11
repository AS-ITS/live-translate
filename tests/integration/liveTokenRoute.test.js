import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createRequestHandler } from '../../server/index.js';
import { buildTokenConfig, normalizeTokenRequest } from '../../server/tokenService.js';
import { createTranslationExecutionMetrics } from '../../src/application/translation/translationExecutionMetrics.js';

let requestHandler;
let metrics;

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

  await requestHandler(req, response);

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
  metrics = createTranslationExecutionMetrics({ clock: () => '2026-08-10T00:00:00.000Z' });
  requestHandler = createRequestHandler({
    translationExecutionMetrics: metrics,
    async liveTokenCreator(body) {
      if (!process.env.GEMINI_API_KEY) {
        throw new Error('GEMINI_API_KEY is not configured');
      }
      if (process.env.MOCK_GOOGLE_GENAI_AUTH_ERROR) {
        throw new Error('Failed to create Gemini ephemeral token', {
          cause: new Error(process.env.MOCK_GOOGLE_GENAI_AUTH_ERROR)
        });
      }
      const config = buildTokenConfig(normalizeTokenRequest(body));
      globalThis.__mockGoogleGenAI.clients.push({ httpOptions: config.httpOptions });
      globalThis.__mockGoogleGenAI.tokenCreates.push({ config });
      return {
        token: process.env.MOCK_GOOGLE_GENAI_TOKEN_NAME || 'mock-token-name',
        expiresAt: config.expireTime
      };
    }
  });
});

test.afterEach(() => {
  resetMock();
  delete process.env.GEMINI_API_KEY;
  delete process.env.NODE_ENV;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SECRET_KEY;
  delete process.env.SUPABASE_JWKS_URL;
  delete process.env.AUTH_ALLOWED_EMAIL_DOMAINS;
  delete process.env.RATE_LIMIT_MAX;
  delete process.env.RATE_LIMIT_WINDOW_MS;
  delete process.env.dev_frontend_origin;
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
  assert.equal(body.token, 'mock-token-name');
  assert.match(body.expiresAt, /^\d{4}-\d{2}-\d{2}T/);

  assert.deepEqual(globalThis.__mockGoogleGenAI.clients[0].httpOptions, { apiVersion: 'v1beta' });
  assert.equal(globalThis.__mockGoogleGenAI.tokenCreates[0].config.liveConnectConstraints.config.generationConfig.translationConfig.targetLanguageCode, 'ja');
});

test('POST /api/live-token can return the server-constrained live connect config', async () => {
  requestHandler = createRequestHandler({
    async liveTokenCreator(body) {
      const config = buildTokenConfig({
        ...normalizeTokenRequest(body),
        glossaryEntries: [{ source: 'Codex', target: 'コーデックス' }]
      });
      return {
        token: 'mock-token-name',
        expiresAt: config.expireTime,
        liveConnectModel: config.liveConnectConstraints.model,
        liveConnectConfig: config.liveConnectConstraints.config,
        liveGlossaryEntries: [{ source: 'Codex', target: 'コーデックス', replacementAliases: [] }]
      };
    }
  });

  const response = await postJson({
    targetLanguageCode: 'ja',
    echoTargetLanguage: false
  });
  const body = response.json();

  assert.equal(response.status, 200);
  assert.equal(body.liveConnectModel, 'gemini-3.5-live-translate-preview');
  assert.equal(body.liveConnectConfig.generationConfig.translationConfig.targetLanguageCode, 'ja');
  assert.match(body.liveConnectConfig.systemInstruction.parts[0].text, /Codex/);
  assert.deepEqual(body.liveGlossaryEntries, [{ source: 'Codex', target: 'コーデックス', replacementAliases: [] }]);
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

test('POST /api/live-token rejects invalid source language', async () => {
  process.env.GEMINI_API_KEY = 'test-api-key';

  const response = await postJson({ targetLanguageCode: 'ja', sourceLanguageCode: 'xx' });
  const body = response.json();

  assert.equal(response.status, 400);
  assert.equal(body.error.code, 'unsupported_language');
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

test('POST /api/live-token rejects disallowed origin', async () => {
  process.env.GEMINI_API_KEY = 'test-api-key';
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

test('GET /readyz stays unavailable when production auth configuration is incomplete', async () => {
  process.env.NODE_ENV = 'production';
  process.env.SUPABASE_URL = 'https://project.supabase.co';
  process.env.SUPABASE_SECRET_KEY = 'service-role-key';
  process.env.SUPABASE_JWKS_URL = '';
  process.env.AUTH_ALLOWED_EMAIL_DOMAINS = '';

  const response = await request({ method: 'GET', url: '/readyz' });

  assert.equal(response.status, 503);
  assert.equal(response.json().error.code, 'supabase_unavailable');
});

test('GET /api/metrics returns the protected process-local queue snapshot', async () => {
  metrics.increment('translation_queue_processed_total', 2);
  metrics.setGauge('translation_queue_depth', 3);

  const response = await request({ method: 'GET', url: '/api/metrics' });

  assert.equal(response.status, 200);
  assert.deepEqual(response.json(), {
    metrics: {
      translation_queue_depth: 3,
      translation_queue_processed_total: 2,
      translation_queue_skipped_total: 0,
      translation_queue_cancelled_total: 0,
      translation_queue_retry_total: 0,
      translation_queue_failed_total: 0,
      translation_queue_dlq_transfer_total: 0,
      translation_queue_recovery_total: 0,
      translation_queue_lease_error_total: 0,
      translation_queue_acknowledgement_error_total: 0,
      translation_queue_last_success_at: null
    },
    generatedAt: '2026-08-10T00:00:00.000Z',
    requestId: response.json().requestId
  });
});
