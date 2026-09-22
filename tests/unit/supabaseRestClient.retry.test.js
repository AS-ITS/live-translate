import assert from 'node:assert/strict';
import test from 'node:test';
import { createSupabaseUserClient } from '../../src/infrastructure/supabaseRestClient.js';

test('Supabase GET retries transient 503/504 responses but POST does not retry', async () => {
  const calls = [];
  const client = createSupabaseUserClient({
    env: {
      SUPABASE_URL: 'https://project.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'publishable-key'
    },
    accessToken: 'user-jwt',
    getRetryDelayMs: 0,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (options.method === 'GET') {
        const getAttempts = calls.filter(({ options: requestOptions }) => requestOptions.method === 'GET').length;
        const status = getAttempts < 3 ? (getAttempts === 1 ? 503 : 504) : 200;
        return { ok: status === 200, status, async json() { return []; } };
      }
      return { ok: false, status: 503, async json() { return {}; } };
    }
  });

  await client.request('meetings');
  assert.equal(calls.filter(({ options }) => options.method === 'GET').length, 3);

  await assert.rejects(client.rpc('translation_queue_claim'), (error) => error.status === 503);
  assert.equal(calls.filter(({ options }) => options.method === 'POST').length, 1);
});
