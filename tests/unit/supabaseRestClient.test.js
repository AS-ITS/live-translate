import assert from 'node:assert/strict';
import test from 'node:test';
import { createSupabaseServiceRoleClient, createSupabaseUserClient } from '../../src/infrastructure/supabaseRestClient.js';

test('Supabase user client sends the caller JWT and never the service key', async () => {
  const calls = [];
  const client = createSupabaseUserClient({
    env: {
      SUPABASE_URL: 'https://project.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'publishable-key',
      SUPABASE_SECRET_KEY: 'service-key'
    },
    accessToken: 'user-jwt',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, async json() { return []; } };
    }
  });

  await client.request('meetings', { query: '?select=id' });
  assert.equal(calls[0].options.headers.apikey, 'publishable-key');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer user-jwt');
  assert.doesNotMatch(JSON.stringify(calls[0].options.headers), /service-key/);
});

test('Supabase service-role client remains explicit for privileged operations', async () => {
  const calls = [];
  const client = createSupabaseServiceRoleClient({
    env: { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SECRET_KEY: 'service-key' },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, async json() { return []; } };
    }
  });

  await client.request('observability_metric_buckets');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer service-key');
});
