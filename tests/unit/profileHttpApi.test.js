import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createRequestHandler } from '../../server/index.js';

function request(handler, headers = {}, url = '/api/profile') {
  const req = Readable.from([]);
  req.method = 'GET'; req.url = url; req.headers = headers; req.socket = { remoteAddress: '127.0.0.1' };
  const response = { statusCode: 0, body: '', writeHead(status) { this.statusCode = status; }, end(body = '') { this.body = body; } };
  return handler(req, response).then(() => ({ ...response, json: JSON.parse(response.body) }));
}

test('profile API returns the authenticated user profile only', async () => {
  const handler = createRequestHandler({
    accessControl: { validateRequest: () => ({ id: 'user-a', email: 'a@example.com' }) },
    profileService: { getProfile: async (user) => ({ id: user.id, email: user.email }) }
  });
  const response = await request(handler, { authorization: 'Bearer signed-token' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json.profile, { id: 'user-a', email: 'a@example.com' });
});

test('profile API exposes only safe role and status metadata', async () => {
  const handler = createRequestHandler({
    accessControl: { validateRequest: () => ({ id: 'admin', email: 'admin@example.com' }) },
    profileService: { getProfile: async () => ({ id: 'admin', email: 'admin@example.com', role: 'super_admin', status: 'active' }) }
  });
  const response = await request(handler, { authorization: 'Bearer signed-token' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json.profile, { id: 'admin', email: 'admin@example.com', role: 'super_admin', status: 'active' });
});

test('disabled profiles cannot access private APIs', async () => {
  const handler = createRequestHandler({
    accessControl: { validateRequest: () => ({ id: 'disabled', email: 'disabled@example.com' }) },
    profileService: { getProfile: async () => ({ id: 'disabled', email: 'disabled@example.com', role: 'member', status: 'disabled' }) }
  });
  const response = await request(handler, { authorization: 'Bearer signed-token' });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json.error.code, 'auth_forbidden');
});

test('pending profiles can read their status and removed credential API is not found', async () => {
  const handler = createRequestHandler({
    accessControl: { validateRequest: () => ({ id: 'pending', email: 'pending@example.com' }) },
    profileService: { getProfile: async () => ({ id: 'pending', email: 'pending@example.com', role: 'member', status: 'pending' }) }
  });
  const profile = await request(handler, { authorization: 'Bearer signed-token' });
  assert.equal(profile.statusCode, 200);
  assert.equal(profile.json.profile.status, 'pending');

  const removedCredentialHandler = createRequestHandler({
    accessControl: { validateRequest: () => ({ id: 'active', email: 'active@example.com' }) },
    profileService: { getProfile: async () => ({ id: 'active', email: 'active@example.com', role: 'member', status: 'active' }) }
  });
  const removedCredentialResponse = await request(removedCredentialHandler, { authorization: 'Bearer signed-token' }, '/api/profile/gemini-credential');
  assert.equal(removedCredentialResponse.statusCode, 404);
  assert.equal(removedCredentialResponse.json.error.code, 'not_found');
});
