import assert from 'node:assert/strict';
import test from 'node:test';
import { formatPreflightResult, normalizeSmokeBaseUrl, runDeploymentPreflight } from '../../scripts/deployment-preflight.js';

function response(status, body = {}) { return { status, async json() { return body; } }; }

function mockFetch(responses) {
  const calls = [];
  return { calls, fetchImpl: async (url, options) => { calls.push({ url, options }); return responses[new URL(url).pathname]; } };
}

test('normalizes and validates the smoke base URL', () => {
  assert.equal(normalizeSmokeBaseUrl('https://example.com/app/?token=secret'), 'https://example.com/app');
  assert.throws(() => normalizeSmokeBaseUrl(''), /SMOKE_BASE_URL is required/);
  assert.throws(() => normalizeSmokeBaseUrl('ftp://example.com'), /http or https/);
});

test('deployment preflight passes without credentials or provider calls', async () => {
  const mock = mockFetch({ '/healthz': response(200, { ok: true }), '/readyz': response(200, { ok: true }), '/api/meetings': response(401), '/api/metrics': response(401), '/api/internal/worker': response(401) });
  const result = await runDeploymentPreflight({ baseUrl: 'https://example.com', fetchImpl: mock.fetchImpl });
  assert.equal(result.passed, true);
  assert.deepEqual(mock.calls.map((call) => [call.options.method, new URL(call.url).pathname]), [['GET', '/healthz'], ['GET', '/readyz'], ['GET', '/api/meetings'], ['GET', '/api/metrics'], ['POST', '/api/internal/worker']]);
  assert.ok(mock.calls.every((call) => !call.options.headers));
});

test('deployment preflight reports readiness failures without response secrets', async () => {
  const mock = mockFetch({ '/healthz': response(200, { ok: true }), '/readyz': response(503, { ok: false, token: 'secret-token' }), '/api/meetings': response(401), '/api/metrics': response(401), '/api/internal/worker': response(401) });
  const result = await runDeploymentPreflight({ baseUrl: 'https://example.com', fetchImpl: mock.fetchImpl });
  const output = formatPreflightResult(result);
  assert.equal(result.passed, false);
  assert.match(output, /readiness: HTTP 503/);
  assert.doesNotMatch(output, /secret-token/);
});

test('deployment preflight reports malformed health responses and timeouts', async () => {
  const result = await runDeploymentPreflight({ baseUrl: 'https://example.com', timeoutMs: 1, fetchImpl: async (url) => {
    if (url.endsWith('/healthz')) return response(200, { ok: false });
    if (url.endsWith('/readyz')) return new Promise(() => {});
    return response(401);
  } });
  assert.equal(result.passed, false);
  assert.equal(result.results[0].error, 'response did not contain ok=true');
  assert.match(result.results[1].error, /timed out/);
});
