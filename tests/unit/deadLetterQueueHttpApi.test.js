import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createRequestHandler } from '../../server/index.js';

function handler(controller) {
  return createRequestHandler({
    sessionReadController: { listSessions() { return []; }, getSession() { return null; } },
    deadLetterQueueController: controller
  });
}

async function request(requestHandler, method, url) {
  const req = Readable.from([]);
  req.method = method;
  req.url = url;
  req.headers = {};
  req.socket = { remoteAddress: '127.0.0.1' };
  const response = { statusCode: null, body: '', writeHead(status, headers) { this.statusCode = status; this.headers = headers; }, end(body = '') { this.body = body; } };
  await requestHandler(req, response);
  return { status: response.statusCode, json: () => JSON.parse(response.body) };
}

test('authenticated DLQ list and replay routes return application results', async () => {
  const calls = [];
  const requestHandler = handler({
    listItems() { return { items: [{ executionId: 'execution-1' }], size: 1 }; },
    replayItem(input) {
      calls.push(input);
      return { sourceExecutionId: 'execution-1', execution: { id: 'execution-2', status: 'queued', translationRequestId: 'request-1' } };
    }
  });

  assert.deepEqual((await request(requestHandler, 'GET', '/api/translation-dead-letter-queue')).json(), {
    items: [{ executionId: 'execution-1' }], size: 1
  });
  const replay = await request(requestHandler, 'POST', '/api/translation-dead-letter-queue/execution-1/replay');
  assert.equal(replay.status, 202);
  assert.deepEqual(replay.json(), {
    sourceExecutionId: 'execution-1',
    execution: { id: 'execution-2', status: 'queued', translationRequestId: 'request-1' }
  });
  assert.deepEqual(calls, [{ executionId: 'execution-1' }]);
});

test('unconfigured DLQ returns 503 and malformed replay IDs return 400', async () => {
  const unavailable = await request(handler(undefined), 'GET', '/api/translation-dead-letter-queue');
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.json().error.code, 'dead_letter_queue_unavailable');

  const malformed = await request(handler({ listItems() {}, replayItem() {} }), 'POST', '/api/translation-dead-letter-queue/%20/replay');
  assert.equal(malformed.status, 400);
  assert.equal(malformed.json().error.code, 'invalid_request');
});
