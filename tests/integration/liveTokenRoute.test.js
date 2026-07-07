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

async function request({ method = 'POST', url = '/api/live-token', body = '' } = {}) {
  const req = Readable.from(body ? [body] : []);
  req.method = method;
  req.url = url;

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
  assert.deepEqual(body, { error: 'Unsupported targetLanguageCode' });

  assert.equal(globalThis.__mockGoogleGenAI.tokenCreates.length, 0);
});

test('POST /api/live-token rejects requests when api key is missing', async () => {
  delete process.env.GEMINI_API_KEY;

  const response = await postJson({ targetLanguageCode: 'en' });
  const body = response.json();

  assert.equal(response.status, 500);
  assert.deepEqual(body, { error: 'GEMINI_API_KEY is not configured' });
});

test('POST /api/live-token maps expired-token provider failures to error response', async () => {
  process.env.GEMINI_API_KEY = 'test-api-key';
  process.env.MOCK_GOOGLE_GENAI_AUTH_ERROR = 'expired token';

  const response = await postJson({ targetLanguageCode: 'en' });
  const body = response.json();

  assert.equal(response.status, 502);
  assert.deepEqual(body, { error: 'Failed to create Gemini ephemeral token' });
});

test('POST /api/live-token returns structured error response for invalid JSON', async () => {
  process.env.GEMINI_API_KEY = 'test-api-key';

  const response = await request({ body: '{not-json' });
  const body = response.json();

  assert.equal(response.status, 400);
  assert.deepEqual(body, { error: 'Invalid JSON body' });
});
