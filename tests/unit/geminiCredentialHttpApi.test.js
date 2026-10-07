import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createRequestHandler } from '../../server/index.js';

function request(handler, { method, url, body = '' }) {
  const req = Readable.from(body ? [body] : []);
  req.method = method;
  req.url = url;
  req.headers = { authorization: 'Bearer signed-token' };
  req.socket = { remoteAddress: '127.0.0.1' };
  const response = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers = {}) { this.statusCode = status; this.headers = headers; },
    end(value = '') { this.body = value; }
  };
  return handler(req, response).then(() => ({
    status: response.statusCode,
    headers: response.headers,
    json: JSON.parse(response.body || '{}')
  }));
}

test('legacy profile credential API is not found for every former method', async () => {
  const handler = createRequestHandler({
    accessControl: { validateRequest: async () => ({ id: 'user-a', email: 'a@example.com', role: 'member', status: 'active' }) }
  });

  for (const method of ['GET', 'PUT', 'DELETE']) {
    const result = await request(handler, {
      method,
      url: '/api/profile/gemini-credential',
      body: method === 'PUT' ? JSON.stringify({ apiKey: 'legacy-secret' }) : ''
    });
    assert.equal(result.status, 404);
    assert.equal(result.json.error.code, 'not_found');
    assert.doesNotMatch(JSON.stringify(result.json), /legacy-secret/);
  }
});

test('live-token uses only the explicit request key', async () => {
  let receivedKey = null;
  const handler = createRequestHandler({
    accessControl: { validateRequest: async () => ({ id: 'user-a', email: 'a@example.com', role: 'member', status: 'active' }) },
    profileService: { async getProfile() { return { role: 'member', status: 'active' }; } },
    meetingMembershipService: {
      async canRecord(meetingId, userId) { return meetingId === 'meeting-1' && userId === 'user-a'; },
      async getMeetingOwner() { return 'user-a'; }
    },
    sessionReadController: {
      async getSession(sessionId) {
        return sessionId === 'session-1'
          ? { sessionRecord: { id: sessionId, meetingId: 'meeting-1', targetLanguageCode: 'en', sourceLanguageCode: 'zh-Hant' } }
          : null;
      }
    },
    liveTokenCreator: async (_body, options) => {
      receivedKey = options.apiKey;
      return { token: 'ephemeral-token' };
    }
  });

  const result = await request(handler, {
    method: 'POST',
    url: '/api/live-token',
    body: JSON.stringify({
      meetingId: 'meeting-1',
      sessionId: 'session-1',
      targetLanguageCode: 'en',
      geminiApiKey: 'request-only-secret'
    })
  });

  assert.equal(result.status, 200);
  assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.equal(result.json.token, 'ephemeral-token');
  assert.equal(receivedKey, 'request-only-secret');
  assert.doesNotMatch(JSON.stringify(result.json), /request-only-secret/);
});
