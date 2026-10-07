import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createRequestHandler } from '../../server/index.js';

function makeRequest(handler, { method = 'GET', url = '/', body, headers = {} } = {}) {
  const req = Readable.from(body ? [body] : []);
  req.method = method;
  req.url = url;
  req.headers = headers;
  const res = {
    headers: {},
    statusCode: 0,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    writeHead(status, responseHeaders = {}) { this.statusCode = status; Object.assign(this.headers, responseHeaders); },
    end(chunk = '') { this.body = String(chunk); this.resolve({ statusCode: this.statusCode, headers: this.headers, json: this.body ? JSON.parse(this.body) : null }); }
  };
  return new Promise((resolve) => { res.resolve = resolve; void handler(req, res); });
}

function handlerFor(user, adminService) {
  return createRequestHandler({
    accessControl: { validateRequest: async () => user },
    profileService: { getProfile: async () => user },
    adminService
  });
}

test('role PATCH keeps API authorization and uses the authenticated server identity', async () => {
  const actor = { id: 'admin-1', email: 'admin@example.com', role: 'super_admin', status: 'active' };
  let received;
  const handler = handlerFor(actor, {
    updateUserRole: async (...args) => {
      received = args;
      return { changed: false, user: { id: 'user-2', email: 'user@example.com', role: 'member', status: 'active' } };
    }
  });

  const response = await makeRequest(handler, {
    method: 'PATCH',
    url: '/api/admin/users/user-2/role',
    headers: { authorization: 'Bearer signed-token', 'content-type': 'application/json' },
    body: JSON.stringify({ role: 'member', operatorId: 'attacker', operatorRole: 'super_admin' })
  });

  assert.equal(response.statusCode, 200, JSON.stringify(response.json));
  assert.equal(response.json.changed, false);
  assert.equal(received[0].id, actor.id);
  assert.equal(received[0].role, 'super_admin');
  assert.equal(received[0].status, 'active');
  assert.equal(received[1], 'user-2');
  assert.equal(received[2], 'member');
});

test('member and unauthenticated requests cannot reach role mutation service', async () => {
  let calls = 0;
  const adminService = { updateUserRole: async () => { calls += 1; } };
  const member = { id: 'member-1', email: 'member@example.com', role: 'member', status: 'active' };
  const memberResponse = await makeRequest(handlerFor(member, adminService), {
    method: 'PATCH',
    url: '/api/admin/users/user-2/role',
    headers: { authorization: 'Bearer signed-token', 'content-type': 'application/json' },
    body: JSON.stringify({ role: 'super_admin' })
  });
  assert.equal(memberResponse.statusCode, 403);
  assert.equal(memberResponse.json.error.code, 'auth_forbidden');

  const unauthenticated = createRequestHandler({
    accessControl: { validateRequest: async () => { throw Object.assign(new Error('required'), { code: 'auth_required', status: 401 }); } },
    profileService: { getProfile: async () => { throw new Error('must not run'); } },
    adminService
  });
  const unauthenticatedResponse = await makeRequest(unauthenticated, {
    method: 'PATCH',
    url: '/api/admin/users/user-2/role',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role: 'super_admin' })
  });
  assert.equal(unauthenticatedResponse.statusCode, 401);
  assert.equal(unauthenticatedResponse.json.error.code, 'auth_required');
  assert.equal(calls, 0);
});
