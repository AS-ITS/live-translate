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

test('Supabase readiness checks core tables, RPCs, and Storage buckets', async () => {
  const calls = [];
  const client = createSupabaseServiceRoleClient({
    env: {
      SUPABASE_URL: 'https://project.supabase.co',
      SUPABASE_SECRET_KEY: 'service-key'
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        async json() { return {}; }
      };
    }
  });

  await client.healthCheck({
    tables: ['meetings'],
    rpcFunctions: [{ name: 'translation_queue_claim', body: { p_execution_id: 'probe' } }],
    storageBuckets: ['meeting-audio']
  });

  assert.deepEqual(calls.map(({ url }) => url), [
    'https://project.supabase.co/rest/v1/meetings?select=*&limit=0',
    'https://project.supabase.co/rest/v1/rpc/translation_queue_claim',
    'https://project.supabase.co/storage/v1/bucket/meeting-audio'
  ]);
  assert.ok(calls.every(({ options }) => options.headers.Authorization === 'Bearer service-key'));
});
