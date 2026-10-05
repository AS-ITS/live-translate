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
