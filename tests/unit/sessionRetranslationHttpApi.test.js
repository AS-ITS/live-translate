import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createRequestHandler } from '../../server/index.js';

test('POST /api/sessions/:sessionId/retranslations returns 202 and never forwards source overrides', async () => {
  const calls = [];
  let wakeCount = 0;
  const handler = createRequestHandler({
    sessionRetranslationCommandController: { submitRetranslation: (input) => { calls.push(input); return { request: { id: 'r' }, execution: { id: 'e', status: 'queued' } }; } },
    translationExecutionWorkerRuntime: { wake() { wakeCount += 1; } }
  });
  const accepted = await request(handler, '/api/sessions/session-1/retranslations', { targetLanguageCode: 'ja', providerKey: 'gemini' });
  assert.equal(accepted.status, 202);
  assert.equal(wakeCount, 1);
  assert.deepEqual(calls, [{ sessionId: 'session-1', targetLanguageCode: 'ja', providerKey: 'gemini' }]);
  const rejected = await request(handler, '/api/sessions/session-1/retranslations', { targetLanguageCode: 'ja', sourceText: 'override' });
  assert.equal(rejected.status, 400);
  assert.equal(wakeCount, 1);
  assert.deepEqual(calls, [{ sessionId: 'session-1', targetLanguageCode: 'ja', providerKey: 'gemini' }]);
});

test('GET /api/translation-providers returns only safe provider options', async () => {
  const handler = createRequestHandler({});
  const response = await get(handler, '/api/translation-providers');
  assert.equal(response.status, 200);
  assert.deepEqual(response.json(), {
    providers: [{
      key: 'gemini',
      label: 'Gemini',
      provider: 'gemini',
      model: 'gemini saved transcript retranslation'
    }]
  });
});

async function request(handler, url, body) {
  const req = Readable.from([JSON.stringify(body)]);
  req.method = 'POST'; req.url = url; req.headers = {};
  const response = { statusCode: null, headers: {}, body: '', writeHead(status, headers) { this.statusCode = status; this.headers = headers; }, end(value) { this.body += value; } };
  await handler(req, response);
  return { status: response.statusCode, json: () => JSON.parse(response.body) };
}

async function get(handler, url) {
  const req = Readable.from([]);
  req.method = 'GET'; req.url = url; req.headers = {};
  const response = { statusCode: null, headers: {}, body: '', writeHead(status, headers) { this.statusCode = status; this.headers = headers; }, end(value) { this.body += value; } };
  await handler(req, response);
  return { status: response.statusCode, json: () => JSON.parse(response.body) };
}
