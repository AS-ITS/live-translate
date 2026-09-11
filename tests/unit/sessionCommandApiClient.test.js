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

test('preserves Session API request diagnostics for failed commands', async () => {
  const client = createSessionCommandApiClient({
    fetchImpl: async () => response({
      error: {
        code: 'supabase_unavailable',
        message: 'Local Supabase is unavailable.',
        requestId: 'request-123'
      }
    }, { ok: false, status: 503 })
  });

  await assert.rejects(
    client.create({ targetLanguageCode: 'en' }),
    (error) => error.status === 503
      && error.code === 'supabase_unavailable'
      && error.requestId === 'request-123'
      && error.serverMessage === 'Local Supabase is unavailable.'
      && error.message.includes('Request ID: request-123')
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
