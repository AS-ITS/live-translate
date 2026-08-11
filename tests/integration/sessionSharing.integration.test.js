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
import { createSessionShareService } from '../../src/application/sessionShareService.js';
import { createFileSessionShareService } from '../../src/infrastructure/fileSessionShareService.js';
import { createSessionEventBroadcaster } from '../../src/infrastructure/sessionEventBroadcaster.js';
import { createFileRecorderLeaseService } from '../../src/infrastructure/fileRecorderLeaseService.js';

test('Recorder share claims one backend lease while Viewer remains read-only', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'live-translate-recorder-api-'));
  const fileSystem = await import('node:fs/promises');
  const sessionRepository = createMemorySessionRepository({ idFactory: () => 'session-1', now: () => 1000 });
  const sessionReadRepository = createSessionReadRepository({ sessionRepository });
  const sessionReadController = createSessionReadController({ sessionQueryService: createSessionQueryService({ sessionReadRepository }) });
  const handler = createRequestHandler({
    sessionRepository,
    sessionReadController,
    sessionShareService: createSessionShareService({ clock: () => 1000 }),
    recorderLeaseService: createFileRecorderLeaseService({ filePath: join(directory, 'leases.json'), fileSystem, clock: () => 1000 })
  });
  const server = http.createServer(handler);
  await listen(server);
  try {
    const created = await request(server, 'POST', '/api/sessions', { targetLanguageCode: 'en' });
    const viewer = await request(server, 'POST', `/api/sessions/${created.body.session.id}/shares`, {});
    const recorder = await request(server, 'POST', `/api/sessions/${created.body.session.id}/shares`, { role: 'recorder' });
    assert.equal(recorder.body.share.role, 'recorder');
    assert.match(recorder.body.recorderCodeUrl, /^#record\?code=/);
    const denied = await request(server, 'POST', `/api/shared-sessions/${viewer.body.share.token}/recorder-lease`, {});
    assert.equal(denied.status, 403);
    const lease = await request(server, 'POST', `/api/shared-sessions/code/${encodeURIComponent(recorder.body.share.shortCode)}/recorder-lease`, {});
    assert.equal(lease.status, 200);
    const duplicate = await request(server, 'POST', `/api/shared-sessions/${recorder.body.share.token}/recorder-lease`, {});
    assert.equal(duplicate.status, 409);
  } finally {
    await close(server);
  }
});

test('Recorder writes require the current grant and cannot change Session metadata', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'live-translate-recorder-write-api-'));
  const fileSystem = await import('node:fs/promises');
  const sessionRepository = createMemorySessionRepository({ idFactory: () => 'session-1', now: () => 1000 });
  const sessionReadRepository = createSessionReadRepository({ sessionRepository });
  const sessionReadController = createSessionReadController({ sessionQueryService: createSessionQueryService({ sessionReadRepository }) });
  const handler = createRequestHandler({
    sessionRepository,
    sessionReadController,
    sessionShareService: createSessionShareService({ clock: () => 1000 }),
    recorderLeaseService: createFileRecorderLeaseService({ filePath: join(directory, 'leases.json'), fileSystem, clock: () => 1000 })
  });
  const server = http.createServer(handler);
  await listen(server);
  try {
    const created = await request(server, 'POST', '/api/sessions', { targetLanguageCode: 'en', name: 'Protected' });
    const share = await request(server, 'POST', `/api/sessions/${created.body.session.id}/shares`, { role: 'recorder', expiresAt: 100000 });
    const claim = await request(server, 'POST', `/api/shared-sessions/${share.body.share.token}/recorder-lease`, {});
    const headers = {
      'X-Recorder-Token': share.body.share.token,
      'X-Recorder-Grant': claim.body.recorderGrant,
      'X-Recorder-Lease-Id': claim.body.lease.leaseId,
      'X-Recorder-Fence-Token': String(claim.body.lease.fenceToken)
    };

    const forbidden = await request(server, 'PUT', `/api/sessions/${created.body.session.id}`, {
      ...snapshotFor(created.body.session.id, 'source', 'translation'),
      session: { ...snapshotFor(created.body.session.id, 'source', 'translation').session, name: 'mutated' }
    }, headers);
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.error.code, 'recorder_forbidden');

    const accepted = await request(server, 'PUT', `/api/sessions/${created.body.session.id}`, snapshotFor(created.body.session.id, 'source', 'translation'), headers);
    assert.equal(accepted.status, 200);
  } finally {
    await close(server);
  }
});

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

test('Session sharing publishes only the selected Session and restores the latest snapshot on reconnect', async () => {
  const sessionRepository = createMemorySessionRepository({
    idFactory: (() => {
      let nextId = 0;
      return () => `session-${++nextId}`;
    })(),
    now: () => 1000
  });
  const sessionReadRepository = createSessionReadRepository({ sessionRepository });
  const sessionReadController = createSessionReadController({
    sessionQueryService: createSessionQueryService({ sessionReadRepository })
  });
  const sessionEventBroadcaster = createSessionEventBroadcaster();
  const handler = createRequestHandler({ sessionRepository, sessionReadController, sessionEventBroadcaster });
  const server = http.createServer(handler);
  await listen(server);

  try {
    const sessionA = await request(server, 'POST', '/api/sessions', { targetLanguageCode: 'en', name: 'A' });
    const sessionB = await request(server, 'POST', '/api/sessions', { targetLanguageCode: 'ja', name: 'B' });
    const share = await request(server, 'POST', `/api/sessions/${sessionA.body.session.id}/shares`, {});
    const token = share.body.share.token;

    await request(server, 'PUT', `/api/sessions/${sessionA.body.session.id}`, snapshotFor(sessionA.body.session.id, 'A initial', 'A initial translated'));
    const firstEvent = sessionEventBroadcaster.snapshot(sessionA.body.session.id);
    assert.equal(firstEvent.sequence, 1);
    assert.equal(firstEvent.payload.sessionRecord.id, sessionA.body.session.id);
    await request(server, 'PUT', `/api/sessions/${sessionA.body.session.id}`, snapshotFor(sessionA.body.session.id, 'A update', 'A translated'));
    const updateEvent = sessionEventBroadcaster.snapshot(sessionA.body.session.id);
    assert.equal(updateEvent.sequence, 2);
    assert.equal(updateEvent.payload.transcriptItems[0].text, 'A update');
    await request(server, 'PUT', `/api/sessions/${sessionB.body.session.id}`, snapshotFor(sessionB.body.session.id, 'B update', 'B translated'));
    assert.equal(updateEvent.payload.transcriptItems.some((item) => item.text.includes('B')), false);

    const viewerDetail = await request(server, 'GET', `/api/shared-sessions/${token}`);
    assert.equal(viewerDetail.body.session.audioArtifacts, undefined);
    assert.equal(viewerDetail.body.session.selectedInputDeviceId, undefined);

    await request(server, 'PUT', `/api/sessions/${sessionA.body.session.id}`, snapshotFor(sessionA.body.session.id, 'A stopped', 'A stopped translated', 'stopped'));
    const terminalEvent = sessionEventBroadcaster.snapshot(sessionA.body.session.id);
    assert.equal(terminalEvent.sequence, 3);
    assert.equal(terminalEvent.payload.sessionRecord.status, 'stopped');

    const restoredEvent = sessionEventBroadcaster.snapshot(sessionA.body.session.id);
    assert.equal(restoredEvent.sequence, 3);
    assert.equal(restoredEvent.payload.sessionRecord.id, sessionA.body.session.id);
    assert.equal(restoredEvent.payload.transcriptItems[0].text, 'A stopped');
  } finally {
    await close(server);
  }
});

test('Session share API rejects expired links', async () => {
  let now = 1000;
  const sessionRepository = createMemorySessionRepository({ idFactory: () => 'session-1', now: () => now });
  const sessionReadRepository = createSessionReadRepository({ sessionRepository });
  const sessionReadController = createSessionReadController({
    sessionQueryService: createSessionQueryService({ sessionReadRepository })
  });
  const handler = createRequestHandler({
    sessionRepository,
    sessionReadController,
    sessionShareService: createSessionShareService({ clock: () => now })
  });
  const server = http.createServer(handler);
  await listen(server);

  try {
    const created = await request(server, 'POST', '/api/sessions', { targetLanguageCode: 'en', name: 'Expiring' });
    const share = await request(server, 'POST', `/api/sessions/${created.body.session.id}/shares`, { expiresAt: 1100 });
    assert.equal(share.status, 201);
    now = 1101;

    const expiredDetail = await request(server, 'GET', `/api/shared-sessions/${share.body.share.token}`);
    assert.equal(expiredDetail.status, 404);
    const expiredEvents = await request(server, 'GET', `/api/shared-sessions/${share.body.share.token}/events`);
    assert.equal(expiredEvents.status, 404);
  } finally {
    await close(server);
  }
});

test('shared Viewer routes remain read-only for non-GET methods', async () => {
  const sessionRepository = createMemorySessionRepository({ idFactory: () => 'session-1', now: () => 1000 });
  const sessionReadRepository = createSessionReadRepository({ sessionRepository });
  const sessionReadController = createSessionReadController({
    sessionQueryService: createSessionQueryService({ sessionReadRepository })
  });
  const handler = createRequestHandler({ sessionRepository, sessionReadController });
  const server = http.createServer(handler);
  await listen(server);

  try {
    const created = await request(server, 'POST', '/api/sessions', { targetLanguageCode: 'en', name: 'Read-only' });
    const share = await request(server, 'POST', `/api/sessions/${created.body.session.id}/shares`, {});

    const updateAttempt = await request(server, 'POST', `/api/shared-sessions/${share.body.share.token}`, {});
    const eventMutationAttempt = await request(server, 'POST', `/api/shared-sessions/${share.body.share.token}/events`, {});

    assert.equal(updateAttempt.status, 404);
    assert.equal(eventMutationAttempt.status, 404);
  } finally {
    await close(server);
  }
});

function snapshotFor(sessionId, sourceText, translatedText, status = 'active') {
  return {
    session: {
      id: sessionId,
      status,
      targetLanguageCode: 'en',
      audioArtifacts: {
        input: { downloadUrl: '/private-input.wav' },
        translation: { downloadUrl: '/private-translation.wav' }
      },
      selectedInputDeviceId: 'private-device-id',
      inputDeviceLabelSnapshot: 'Private microphone'
    },
    transcriptItems: [
      { id: `${sessionId}:source:1`, sessionId, segmentId: `${sessionId}:segment-1`, stream: 'source', status: 'final', text: sourceText, sequence: 1, startedAt: 1000, finalizedAt: 1000 },
      { id: `${sessionId}:translation:1`, sessionId, segmentId: `${sessionId}:segment-1`, stream: 'translation', status: 'final', text: translatedText, sequence: 1, startedAt: 1000, finalizedAt: 1000 }
    ]
  };
}

function request(server, method, path, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ port: server.address().port, method, path, headers: { 'Content-Type': 'application/json', ...extraHeaders } }, (response) => {
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
