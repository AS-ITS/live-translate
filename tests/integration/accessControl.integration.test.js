import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createRequestHandler } from '../../server/index.js';
import { createMemorySessionRepository } from '../../src/lib/sessionRepository.js';

function makeRequest(handler, { method = 'GET', url, headers = {}, body = '' } = {}) {
  const req = Readable.from(body ? [body] : []);
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.socket = { remoteAddress: '127.0.0.1' };
  const response = {
    statusCode: null,
    body: '',
    writeHead(status, responseHeaders) { this.statusCode = status; this.headers = responseHeaders; },
    end(bodyText = '') { this.body = bodyText; }
  };
  return handler(req, response).then(() => ({ ...response, json: JSON.parse(response.body || '{}') }));
}

test('private APIs require the shared token while health remains public', async () => {
  const previous = process.env.DEMO_ACCESS_TOKEN;
  process.env.DEMO_ACCESS_TOKEN = 'integration-secret';
  const handler = createRequestHandler({ sessionRepository: createMemorySessionRepository() });

  try {
    const missing = await makeRequest(handler, { url: '/api/sessions' });
    assert.equal(missing.statusCode, 401);
    assert.equal(missing.json.error.code, 'auth_required');

    const invalid = await makeRequest(handler, { url: '/api/sessions', headers: { authorization: 'Bearer wrong' } });
    assert.equal(invalid.statusCode, 401);
    assert.equal(invalid.json.error.code, 'auth_invalid');

    const valid = await makeRequest(handler, {
      method: 'POST',
      url: '/api/sessions',
      headers: { authorization: 'Bearer integration-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ targetLanguageCode: 'en' })
    });
    assert.equal(valid.statusCode, 201);
    assert.equal(valid.json.session.targetLanguageCode, 'en');

    const originRejected = await makeRequest(handler, {
      url: '/api/sessions',
      headers: { authorization: 'Bearer integration-secret', origin: 'https://not-allowed.example' }
    });
    assert.equal(originRejected.statusCode, 403);
    assert.equal(originRejected.json.error.code, 'invalid_origin');

    const health = await makeRequest(handler, { url: '/healthz' });
    assert.equal(health.statusCode, 200);
  } finally {
    if (previous === undefined) delete process.env.DEMO_ACCESS_TOKEN;
    else process.env.DEMO_ACCESS_TOKEN = previous;
  }
});
