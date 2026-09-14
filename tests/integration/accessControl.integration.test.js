import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createApplicationDependencies } from '../../server/compositionRoot.js';
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
    writeHead(status, responseHeaders) {
      this.statusCode = status;
      this.headers = responseHeaders;
    },
    end(bodyText = '') {
      this.body = bodyText;
    }
  };

  return handler(req, response).then(() => ({
    ...response,
    json: JSON.parse(response.body || '{}')
  }));
}

test('private APIs remain available in local test mode while health remains public', async () => {
  const dependencies = createApplicationDependencies({
    sessionRepository: createMemorySessionRepository(),
    requestHandlerFactory: createRequestHandler
  });
  const handler = dependencies.requestHandler;

  const missing = await makeRequest(handler, { url: '/api/sessions' });
  assert.equal(missing.statusCode, 200);

  const invalid = await makeRequest(handler, {
    url: '/api/sessions',
    headers: { authorization: 'Bearer wrong' }
  });
  assert.equal(invalid.statusCode, 200);

  const valid = await makeRequest(handler, {
    method: 'POST',
    url: '/api/sessions',
    headers: {
      authorization: 'Bearer local-test-token',
      'content-type': 'application/json'
    },
    body: JSON.stringify({ targetLanguageCode: 'en' })
  });
  assert.equal(valid.statusCode, 201);
  assert.equal(valid.json.session.targetLanguageCode, 'en');

  const originRejected = await makeRequest(handler, {
    url: '/api/sessions',
    headers: {
      authorization: 'Bearer local-test-token',
      origin: 'https://not-allowed.example'
    }
  });
  assert.equal(originRejected.statusCode, 403);
  assert.equal(originRejected.json.error.code, 'invalid_origin');

  const health = await makeRequest(handler, { url: '/healthz' });
  assert.equal(health.statusCode, 200);
  assert.equal(health.json.ok, true);
});
