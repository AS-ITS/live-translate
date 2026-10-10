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

test('Supabase REST errors retain only safe upstream diagnostics', async () => {
  const client = createSupabaseUserClient({
    env: {
      SUPABASE_URL: 'https://project.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'publishable-key'
    },
    accessToken: 'user-jwt',
    fetchImpl: async () => ({
      ok: false,
      status: 409,
      async json() {
        return {
          code: '23503',
          message: 'insert or update violates foreign key constraint "subtitle_cues_session_segment_relationship_fkey"',
          details: 'Key values and private row data must not be retained.'
        };
      }
    })
  });

  await assert.rejects(
    client.request('subtitle_cues', { method: 'POST', body: [] }),
    (error) => {
      assert.equal(error.code, 'supabase_request_failed');
      assert.equal(error.supabaseStatus, 409);
      assert.equal(error.supabaseCode, '23503');
      assert.equal(error.supabaseErrorClass, 'foreign_key_violation');
      assert.equal(error.supabaseConstraint, 'subtitle_cues_session_segment_relationship_fkey');
      assert.equal(error.supabaseResource, 'subtitle_cues');
      assert.equal(error.supabaseOperation, 'POST');
      assert.equal(error.supabaseDetails, undefined);
      assert.doesNotMatch(JSON.stringify(error), /private row data/u);
      return true;
    }
  );
});

test('Supabase RPC exposes SQLSTATE and RPC name without raw provider details', async () => {
  const client = createSupabaseUserClient({
    env: {
      SUPABASE_URL: 'https://project.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'publishable-key'
    },
    accessToken: 'user-jwt',
    fetchImpl: async () => ({
      ok: false,
      status: 503,
      async json() {
        return {
          code: '57014',
          message: 'private database diagnostics',
          details: 'must not escape'
        };
      }
    })
  });

  await assert.rejects(
    client.rpc('resume_legacy_recording_transaction', {}),
    (error) => {
      assert.equal(error.code, 'supabase_request_failed');
      assert.equal(error.supabaseStatus, 503);
      assert.equal(error.supabaseCode, '57014');
      assert.equal(error.supabaseErrorClass, 'database_request_rejected');
      assert.equal(error.supabaseResource, 'resume_legacy_recording_transaction');
      assert.equal(error.supabaseOperation, 'RPC');
      assert.doesNotMatch(JSON.stringify(error), /private database diagnostics|must not escape/u);
      return true;
    }
  );
});
