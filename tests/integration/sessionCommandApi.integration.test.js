import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createRequestHandler } from '../../server/index.js';
import { createMemorySessionRepository } from '../../src/lib/sessionRepository.js';

test('POST /api/sessions returns a safe diagnostic and logs Supabase failures', async () => {
  const sessionRepository = createMemorySessionRepository({ idFactory: () => 'session-1', now: () => 1000 });
  sessionRepository.createSessionRecord = async () => {
    const error = new Error('Supabase REST endpoint is unavailable.');
    error.code = 'supabase_unavailable';
    error.status = 503;
    error.cause = new Error('secret should never be logged');
    throw error;
  };

  const handler = createRequestHandler({ sessionRepository });
  const server = http.createServer(handler);
  const originalLog = console.log;
  const logs = [];
  console.log = (line) => logs.push(String(line));

  try {
    await listen(server);
    const response = await request(server.address().port, 'POST', '/api/sessions', { targetLanguageCode: 'en' });

    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, 'supabase_unavailable');
    assert.equal(response.body.error.requestId, response.headers['x-request-id']);

    const event = logs.map((line) => JSON.parse(line)).find((item) => item.event === 'session_create');
    assert.equal(event.statusCode, 503);
    assert.equal(event.errorCode, 'supabase_unavailable');
    assert.equal(event.safeSummary, 'Supabase REST endpoint is unavailable.');
    assert.ok(!logs.some((line) => line.includes('secret should never be logged')));
    assert.ok(!logs.some((line) => line.includes('stack')));
  } finally {
    console.log = originalLog;
    await close(server);
  }
});

function request(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const requestBody = JSON.stringify(body);
    const request = http.request({
      host: '127.0.0.1',
      port,
      method,
      path,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(requestBody)
      }
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
      }));
    });
    request.on('error', reject);
    request.end(requestBody);
  });
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
