import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionCommandApiClient } from '../../src/lib/sessionCommandApiClient.js';

test('creates a Session through the command API', async () => {
  const calls = [];
  const client = createSessionCommandApiClient({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response({ session: { id: 'session-1', status: 'created' } });
    }
  });

  const result = await client.create({ name: 'Product meeting', targetLanguageCode: 'en' });

  assert.deepEqual(result.session, { id: 'session-1', status: 'created' });
  assert.equal(calls[0].url, '/api/sessions');
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].options.body), { name: 'Product meeting', targetLanguageCode: 'en' });
});

test('updates a Session and preserves API error code', async () => {
  const client = createSessionCommandApiClient({
    fetchImpl: async () => response({ error: { code: 'session_not_found' } }, { ok: false, status: 404 })
  });

  await assert.rejects(
    client.update('session-1', { status: 'paused' }),
    (error) => error.status === 404 && error.code === 'session_not_found'
  );
});

function response(body, overrides = {}) {
  return {
    ok: true,
    status: 200,
    async json() { return body; },
    ...overrides
  };
}
