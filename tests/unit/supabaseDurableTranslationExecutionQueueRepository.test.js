import assert from 'node:assert/strict';
import test from 'node:test';
import { createSupabaseDurableTranslationExecutionQueueRepository } from '../../src/infrastructure/supabaseDurableTranslationExecutionQueueRepository.js';

const row = {
  execution_id: 'execution-1',
  request_id: 'request-1',
  owner_user_id: 'owner-1',
  enqueued_at: '2026-09-11T00:00:00.000Z',
  status: 'processing',
  available_at: null,
  lease_id: 'lease-1',
  lease_expires_at: '2026-09-11T00:05:00.000Z',
  fence_token: 3,
  attempt: 1,
  last_failure: null
};

function createHarness() {
  const calls = [];
  const repository = createSupabaseDurableTranslationExecutionQueueRepository({
    env: {
      SUPABASE_URL: 'https://supabase.example',
      SUPABASE_SECRET_KEY: 'service-key',
      SUPABASE_WORKER_USER_ID: 'owner-1'
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      return { ok: true, status: 200, async json() { return [row]; } };
    }
  });
  return { calls, repository };
}

test('Supabase queue claim uses an atomic RPC and returns the claimed item', async () => {
  const { calls, repository } = createHarness();

  const result = await repository.claim('execution-1', {
    leaseId: 'lease-1',
    leaseExpiresAt: '2026-09-11T00:05:00.000Z'
  });

  assert.equal(calls[0].url, 'https://supabase.example/rest/v1/rpc/translation_queue_claim');
  assert.deepEqual(calls[0].body, {
    p_execution_id: 'execution-1',
    p_owner_user_id: 'owner-1',
    p_lease_id: 'lease-1',
    p_lease_expires_at: '2026-09-11T00:05:00.000Z'
  });
  assert.equal(result.fenceToken, 3);
});

test('Supabase queue lease operations use ownership and fence RPC arguments', async () => {
  const { calls, repository } = createHarness();
  const claim = { leaseId: 'lease-1', fenceToken: 3 };

  await repository.renewClaim('execution-1', claim, {
    leaseExpiresAt: '2026-09-11T00:06:00.000Z',
    now: '2026-09-11T00:04:00.000Z'
  });
  await repository.acknowledgeClaim('execution-1', claim);
  await repository.requeueExpiredProcessing('execution-1', '2026-09-11T00:06:00.000Z');

  assert.deepEqual(calls.map(({ url }) => url), [
    'https://supabase.example/rest/v1/rpc/translation_queue_renew_claim',
    'https://supabase.example/rest/v1/rpc/translation_queue_acknowledge_claim',
    'https://supabase.example/rest/v1/rpc/translation_queue_requeue_expired'
  ]);
  assert.equal(calls[0].body.p_fence_token, 3);
  assert.equal(calls[1].body.p_lease_id, 'lease-1');
  assert.equal(calls[2].body.p_now, '2026-09-11T00:06:00.000Z');
});
