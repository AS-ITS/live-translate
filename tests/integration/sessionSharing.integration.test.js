import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createSessionQueryService } from '../../src/application/sessionQueryService.js';
import { createMemorySessionRepository } from '../../src/lib/sessionRepository.js';
import { createSessionReadRepository } from '../../src/repositories/sessionReadRepository.js';
import { createSessionReadController } from '../../server/sessionReadController.js';
import { createRequestHandler } from '../../server/index.js';
import { createFileSessionShareService } from '../../src/infrastructure/fileSessionShareService.js';

test('Session share API returns a read-only SSE stream scoped to the Session', async () => {
  const sessionRepository = createMemorySessionRepository({ idFactory: () => 'session-1', now: () => 1000 });
  const sessionReadRepository = createSessionReadRepository({ sessionRepository });
  const sessionReadController = createSessionReadController({
    sessionQueryService: createSessionQueryService({ sessionReadRepository })
  });
  const handler = createRequestHandler({ sessionRepository, sessionReadController });
  const server = http.createServer(handler);
  await listen(server);

  try {
    const created = await request(server, 'POST', '/api/sessions', { targetLanguageCode: 'en', name: 'Demo' });
    assert.equal(created.status, 201);
    const sessionId = created.body.session.id;

    const share = await request(server, 'POST', `/api/sessions/${sessionId}/shares`, {});
    assert.equal(share.status, 201);
    assert.ok(share.body.share.token);

    const detail = await request(server, 'GET', `/api/shared-sessions/${share.body.share.token}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.session.id, sessionId);
    assert.equal(detail.body.session.audioArtifacts, undefined);

    const revoked = await request(server, 'DELETE', `/api/sessions/${sessionId}/shares/${share.body.share.id}`);
    assert.equal(revoked.status, 200);
    const denied = await request(server, 'GET', `/api/shared-sessions/${share.body.share.token}`);
    assert.equal(denied.status, 404);
  } finally {
    await close(server);
  }
});

test('Session share API keeps a link valid when the share service is recreated', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'live-translate-share-api-'));
  const filePath = join(directory, 'shares.json');
  const fs = await import('node:fs/promises');
  const sessionRepository = createMemorySessionRepository({ idFactory: () => 'session-1', now: () => 1000 });
  const sessionReadRepository = createSessionReadRepository({ sessionRepository });
  const sessionReadController = createSessionReadController({
    sessionQueryService: createSessionQueryService({ sessionReadRepository })
  });
  const firstHandler = createRequestHandler({
    sessionRepository,
    sessionReadController,
    sessionShareService: createFileSessionShareService({ filePath, fileSystem: fs, clock: () => 1000 })
  });
  const firstServer = http.createServer(firstHandler);
  await listen(firstServer);

  try {
    const created = await request(firstServer, 'POST', '/api/sessions', { targetLanguageCode: 'en', name: 'Demo' });
    const share = await request(firstServer, 'POST', `/api/sessions/${created.body.session.id}/shares`, {});
    assert.equal(share.status, 201);
    await close(firstServer);

    const secondHandler = createRequestHandler({
      sessionRepository,
      sessionReadController,
      sessionShareService: createFileSessionShareService({ filePath, fileSystem: fs, clock: () => 1000 })
    });
    const secondServer = http.createServer(secondHandler);
    await listen(secondServer);
    try {
      const detail = await request(secondServer, 'GET', `/api/shared-sessions/${share.body.share.token}`);
      assert.equal(detail.status, 200);
      assert.equal(detail.body.session.id, created.body.session.id);
    } finally {
      await close(secondServer);
    }
  } finally {
    if (firstServer.listening) await close(firstServer);
  }
});

function request(server, method, path, body) {
  return new Promise((resolve, reject) => {
    const request = http.request({ port: server.address().port, method, path, headers: { 'Content-Type': 'application/json' } }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: text ? JSON.parse(text) : null }));
    });
    request.on('error', reject);
    if (body !== undefined) request.write(JSON.stringify(body));
    request.end();
  });
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
