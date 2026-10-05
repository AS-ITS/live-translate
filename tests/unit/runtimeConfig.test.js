import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createRequestHandler } from '../../server/index.js';
import { createPublicRuntimeConfig } from '../../server/publicRuntimeConfig.js';
import { DEFAULT_RUNTIME_CONFIG, loadRuntimeConfig } from '../../src/lib/runtimeConfig.js';

test('public runtime config strictly opts in and exposes only the safe boolean', () => {
  assert.deepEqual(createPublicRuntimeConfig(), { livePipelineTraceEnabled: false });
  assert.deepEqual(createPublicRuntimeConfig({ LIVE_PIPELINE_TRACE_ENABLED: 'false' }), {
    livePipelineTraceEnabled: false
  });
  assert.deepEqual(createPublicRuntimeConfig({ LIVE_PIPELINE_TRACE_ENABLED: 'TRUE' }), {
    livePipelineTraceEnabled: false
  });

  const config = createPublicRuntimeConfig({
    LIVE_PIPELINE_TRACE_ENABLED: 'true',
    GEMINI_API_KEY: 'must-not-leak',
    SUPABASE_SERVICE_ROLE_KEY: 'must-not-leak',
    AUTHORIZATION: 'must-not-leak'
  });
  assert.deepEqual(config, { livePipelineTraceEnabled: true });
  assert.deepEqual(Object.keys(config), ['livePipelineTraceEnabled']);
  assert.equal(JSON.stringify(config).includes('must-not-leak'), false);
});

test('runtime config endpoint is public, uncached, and returns only the injected config', async () => {
  let accessControlCalls = 0;
  const handler = createRequestHandler({
    publicRuntimeConfig: Object.freeze({ livePipelineTraceEnabled: true }),
    accessControl: {
      async validateRequest() {
        accessControlCalls += 1;
        throw new Error('runtime config must not require auth');
      }
    }
  });
  const response = await request(handler, '/api/runtime-config');

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.deepEqual(JSON.parse(response.body), { livePipelineTraceEnabled: true });
  assert.equal(accessControlCalls, 0);
});

test('browser runtime config loader accepts only a literal true and fails closed', async () => {
  const requests = [];
  const enabled = await loadRuntimeConfig({
    fetchImpl: async (...args) => {
      requests.push(args);
      return { ok: true, json: async () => ({ livePipelineTraceEnabled: true, token: 'ignored' }) };
    }
  });
  assert.deepEqual(enabled, { livePipelineTraceEnabled: true });
  assert.equal(requests[0][0], '/api/runtime-config');
  assert.equal(requests[0][1].credentials, 'same-origin');

  const nonBoolean = await loadRuntimeConfig({
    fetchImpl: async () => ({ ok: true, json: async () => ({ livePipelineTraceEnabled: 'true' }) })
  });
  assert.deepEqual(nonBoolean, DEFAULT_RUNTIME_CONFIG);

  const failed = await loadRuntimeConfig({ fetchImpl: async () => { throw new Error('offline'); } });
  assert.deepEqual(failed, DEFAULT_RUNTIME_CONFIG);
});

async function request(handler, url) {
  const req = Readable.from([]);
  req.method = 'GET';
  req.url = url;
  req.headers = {};
  req.socket = { remoteAddress: '127.0.0.1' };
  const response = {
    statusCode: null,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name] = value; },
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = { ...this.headers, ...headers };
    },
    end(body = '') { this.body = body; }
  };
  await handler(req, response);
  return response;
}
