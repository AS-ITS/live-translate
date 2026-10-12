import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createRequestHandler } from '../../server/index.js';

function request(handler, { origin }) {
  const req = Readable.from([JSON.stringify({ event: 'login' })]);
  req.method = 'POST';
  req.url = '/api/auth-events';
  req.headers = { origin, authorization: 'Bearer signed-token', 'content-type': 'application/json' };
  req.socket = { remoteAddress: '127.0.0.1' };
  const response = {
    statusCode: null,
    headers: {},
    body: '',
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
    end(body = '') { this.body = body; }
  };
  return handler(req, response).then(() => ({ ...response, json: JSON.parse(response.body || '{}') }));
}

test('auth-events accepts Preview immutable Origin and rejects unrelated Vercel Origin', async () => {
  const previous = {
    VERCEL_ENV: process.env.VERCEL_ENV,
    APP_ORIGIN: process.env.APP_ORIGIN,
    VERCEL_URL: process.env.VERCEL_URL,
    VERCEL_BRANCH_URL: process.env.VERCEL_BRANCH_URL
  };
  Object.assign(process.env, {
    VERCEL_ENV: 'preview',
    APP_ORIGIN: 'https://app.example/',
    VERCEL_URL: 'immutable.vercel.app',
    VERCEL_BRANCH_URL: 'branch.vercel.app'
  });
  try {
    const handler = createRequestHandler({
      accessControl: { validateRequest: async () => ({ id: 'user-1' }) },
      profileService: { async getProfile() { return { status: 'active' }; } },
      authEventAuditLogService: { async record() {} }
    });
    const allowed = await request(handler, { origin: 'https://immutable.vercel.app' });
    assert.equal(allowed.statusCode, 202);
    assert.equal(allowed.headers['Access-Control-Allow-Origin'], 'https://immutable.vercel.app');

    const rejected = await request(handler, { origin: 'https://unrelated.vercel.app' });
    assert.equal(rejected.statusCode, 403);
    assert.equal(rejected.json.error.code, 'invalid_origin');
    assert.equal(rejected.headers['Access-Control-Allow-Origin'], undefined);

    const noOrigin = await request(handler, { origin: undefined });
    assert.equal(noOrigin.statusCode, 202);
    assert.equal(noOrigin.headers['Access-Control-Allow-Origin'], undefined);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
