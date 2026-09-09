import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createRequestHandler } from '../../server/index.js';

function request(handler, { method, url, body = '', user = { id: 'user-a' } }) {
  const req = Readable.from(body ? [body] : []);
  req.method = method;
  req.url = url;
  req.headers = { authorization: 'Bearer signed-token' };
  req.socket = { remoteAddress: '127.0.0.1' };
  const response = { statusCode: 0, body: '', writeHead(status) { this.statusCode = status; }, end(value = '') { this.body = value; } };
  return handler(req, response).then(() => ({ status: response.statusCode, json: JSON.parse(response.body || '{}') }));
}

test('credential API is owner-bound and never returns the full key', async () => {
  const store = new Map();
  const handler = createRequestHandler({
    accessControl: { validateRequest: async () => ({ id: 'user-a', email: 'a@example.com' }) },
    credentialRepository: {
      async get(userId) { return store.get(userId) || null; },
      async upsert(userId, apiKey) { store.set(userId, { configured: true, lastFour: apiKey.slice(-4), keyVersion: 'vault-v1' }); return store.get(userId); },
      async resolveKey(userId) { return userId === 'user-a' ? 'secret-api-key' : null; },
      async remove(userId) { store.delete(userId); }
    }
  });

  const saved = await request(handler, { method: 'PUT', url: '/api/profile/gemini-credential', body: JSON.stringify({ apiKey: 'secret-api-key' }) });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.credential.lastFour, '-key');
  assert.doesNotMatch(JSON.stringify(saved.json), /secret-api-key/);

  const read = await request(handler, { method: 'GET', url: '/api/profile/gemini-credential' });
  assert.equal(read.status, 200);
  assert.equal(read.json.credential.configured, true);
  assert.doesNotMatch(JSON.stringify(read.json), /secret-api-key/);
});

test('live-token resolves only the authenticated user credential', async () => {
  let receivedKey = null;
  const handler = createRequestHandler({
    accessControl: { validateRequest: async () => ({ id: 'user-a', email: 'a@example.com' }) },
    credentialRepository: {
      async get() { return { configured: true, lastFour: '1234' }; },
      async upsert() { return { configured: true, lastFour: '1234' }; },
      async resolveKey(userId) { return userId === 'user-a' ? 'user-a-secret-key' : null; },
      async remove() {}
    },
    liveTokenCreator: async (_body, options) => {
      receivedKey = options.apiKey;
      return { token: 'ephemeral-token' };
    }
  });

  const result = await request(handler, { method: 'POST', url: '/api/live-token', body: JSON.stringify({ targetLanguageCode: 'en' }) });
  assert.equal(result.status, 200);
  assert.equal(result.json.token, 'ephemeral-token');
  assert.equal(receivedKey, 'user-a-secret-key');
});
