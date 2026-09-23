import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createRequestHandler } from '../../server/index.js';

function makeRequest(handler, body, { user = { id: 'recorder-1', role: 'member', status: 'active' }, canRecord = true, resolveKey } = {}) {
  const req = Readable.from([JSON.stringify(body)]);
  req.method = 'POST';
  req.url = '/api/live-token';
  req.headers = { authorization: user ? 'Bearer signed-token' : '' };
  req.socket = { remoteAddress: '127.0.0.1' };
  const response = { statusCode: 0, headers: {}, body: '', writeHead(status, headers) { this.statusCode = status; this.headers = headers; }, end(value = '') { this.body = value; } };
  return handler(req, response).then(() => ({ status: response.statusCode, headers: response.headers, body: JSON.parse(response.body || '{}') }));
}

function handlerFor({ user = { id: 'recorder-1', role: 'member', status: 'active' }, canRecord = true, resolveKey, logs = [] } = {}) {
  return createRequestHandler({
    accessControl: { validateRequest: async () => user },
    profileService: { async getProfile() { return { role: user?.role || 'member', status: user?.status || 'active' }; } },
    credentialRepository: { async resolveKey() { resolveKey?.(); return 'stored-key'; } },
    meetingMembershipService: { async canRecord() { return canRecord; }, async getMeetingOwner() { return canRecord ? 'owner-1' : null; } },
    sessionReadController: { async getSession() { return { sessionRecord: { meetingId: 'meeting-1', targetLanguageCode: 'en', sourceLanguageCode: 'zh-Hant' } }; } },
    requestLogger: (event) => logs.push(event),
    liveTokenCreator: async (body, options) => ({ token: 'ephemeral-token', expiresAt: '2026-09-23T00:30:00.000Z', receivedBody: body, receivedKey: options.apiKey })
  });
}

const validBody = { meetingId: 'meeting-1', sessionId: 'session-1', targetLanguageCode: 'en', geminiApiKey: 'request-only-secret' };

test('live-token fails closed for unauthenticated and viewer requests', async () => {
  const unauthenticated = await makeRequest(handlerFor({ user: null }), validBody, { user: null });
  assert.equal(unauthenticated.status, 401);

  const viewer = await makeRequest(handlerFor({ canRecord: false }), validBody);
  assert.equal(viewer.status, 403);
  assert.equal(viewer.body.error.code, 'recorder_forbidden');
});

test('live-token uses only request key and redacts secrets from response and logs', async () => {
  const logs = [];
  let resolveCalls = 0;
  const handler = handlerFor({ logs, resolveKey: () => { resolveCalls += 1; } });
  const result = await makeRequest(handler, validBody);

  assert.equal(result.status, 200);
  assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.equal(result.body.token, 'ephemeral-token');
  assert.equal(result.body.receivedKey, undefined);
  assert.equal(resolveCalls, 0);
  assert.doesNotMatch(JSON.stringify(result.body), /request-only-secret|stored-key/);
  assert.doesNotMatch(JSON.stringify(logs), /request-only-secret|ephemeral-token/);
});

test('live-token rejects a missing request key without invoking creator', async () => {
  let creatorCalls = 0;
  const handler = createRequestHandler({
    accessControl: { validateRequest: async () => ({ id: 'recorder-1', role: 'member', status: 'active' }) },
    profileService: { async getProfile() { return { role: 'member', status: 'active' }; } },
    meetingMembershipService: { async canRecord() { return true; }, async getMeetingOwner() { return 'owner-1'; } },
    sessionReadController: { async getSession() { return { sessionRecord: { meetingId: 'meeting-1' } }; } },
    liveTokenCreator: async () => { creatorCalls += 1; return { token: 'unexpected' }; }
  });
  const result = await makeRequest(handler, { ...validBody, geminiApiKey: undefined });
  assert.equal(result.status, 500);
  assert.equal(creatorCalls, 0);
});
