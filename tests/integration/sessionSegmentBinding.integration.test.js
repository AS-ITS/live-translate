import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createRequestHandler } from '../../server/index.js';
import { createMemorySessionRepository } from '../../src/lib/sessionRepository.js';

test('PATCH /api/sessions/:sessionId persists the current meeting and segment binding', async () => {
  const sessionRepository = createMemorySessionRepository({ idFactory: () => 'session-1', now: () => 1000 });
  const server = http.createServer(createRequestHandler({ sessionRepository }));

  try {
    await listen(server);
    const created = await request(server.address().port, 'POST', '/api/sessions', { targetLanguageCode: 'en' });
    const updated = await request(server.address().port, 'PATCH', '/api/sessions/session-1', {
      meetingId: 'meeting-1',
      segmentId: 'segment-2'
    });

    assert.equal(created.status, 201);
    assert.equal(updated.status, 200);
    assert.equal(updated.body.session.meetingId, 'meeting-1');
    assert.equal(updated.body.session.segmentId, 'segment-2');
    const persisted = (await sessionRepository.getSessionRecord('session-1')).sessionRecord;
    assert.equal(persisted.meetingId, 'meeting-1');
    assert.equal(persisted.segmentId, 'segment-2');
  } finally {
    await close(server);
  }
});

test('Session metadata PATCH classifies invalid input without changing retired content routes', async () => {
  const sessionRepository = createMemorySessionRepository({ idFactory: () => 'session-1', now: () => 1000 });
  const server = http.createServer(createRequestHandler({ sessionRepository }));
  try {
    await listen(server);
    const port = server.address().port;
    assert.equal((await request(port, 'POST', '/api/sessions', { targetLanguageCode: 'en' })).status, 201);
    const unknown = await request(port, 'PATCH', '/api/sessions/session-1', { unknownMetadata: 'value' });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.error.code, 'invalid_request');
    const invalid = await request(port, 'PATCH', '/api/sessions/session-1', { meetingId: '' });
    assert.equal(invalid.status, 400);
    const invalidValue = await request(port, 'PATCH', '/api/sessions/session-1', { name: { text: 'hidden' } });
    assert.equal(invalidValue.status, 400);
    assert.equal(invalidValue.body.error.code, 'invalid_request');
    const retired = await request(port, 'PUT', '/api/meetings/meeting-1/segments/segment-1/checkpoint', {});
    assert.equal(retired.status, 410);
    assert.equal(retired.body.error.code, 'meeting_content_local_only');
  } finally {
    await close(server);
  }
});

test('Session metadata PATCH maps only its content guard error and preserves other failures', async () => {
  const baseRepository = createMemorySessionRepository({ idFactory: () => 'session-1', now: () => 1000 });
  await baseRepository.createSessionRecord({ targetLanguageCode: 'en' });
  let failure;
  const sessionRepository = {
    ...baseRepository,
    async updateSessionRecord() { throw failure; }
  };
  const server = http.createServer(createRequestHandler({ sessionRepository }));
  try {
    await listen(server);
    const port = server.address().port;
    failure = Object.assign(new Error('RPC rejected content'), {
      code: 'supabase_request_failed', supabaseCode: 'P0043', supabaseMessage: 'meeting_content_local_only'
    });
    const content = await request(port, 'PATCH', '/api/sessions/session-1', { name: 'valid' });
    assert.equal(content.status, 410);
    assert.equal(content.body.error.code, 'meeting_content_local_only');

    failure = Object.assign(new Error('database unavailable'), { code: 'supabase_request_failed' });
    const system = await request(port, 'PATCH', '/api/sessions/session-1', { name: 'valid' });
    assert.equal(system.status, 503);
    assert.equal(system.body.error.code, 'supabase_request_failed');

    failure = Object.assign(new Error('different owner'), { code: 'auth_forbidden' });
    const forbidden = await request(port, 'PATCH', '/api/sessions/session-1', { name: 'valid' });
    assert.equal(forbidden.status, 403);
    failure = Object.assign(new Error('missing token'), { code: 'auth_required' });
    const unauthenticated = await request(port, 'PATCH', '/api/sessions/session-1', { name: 'valid' });
    assert.equal(unauthenticated.status, 401);
  } finally {
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
