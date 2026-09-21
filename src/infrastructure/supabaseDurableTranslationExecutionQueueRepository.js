import { currentRequestOwnerId, isWorkerRequestContext } from '../../server/requestIdentity.js';
import { createDurableTranslationExecutionQueueRepository } from '../application/translation/durableTranslationExecutionQueueRepository.js';
import { createSupabaseServiceRoleClient, eq } from './supabaseRestClient.js';

export function createSupabaseDurableTranslationExecutionQueueRepository({ env = process.env, fetchImpl = globalThis.fetch, clock = () => Date.now() } = {}) {
  const client = createSupabaseServiceRoleClient({ env, fetchImpl });
  if (!client) return null;
  const owner = () => currentRequestOwnerId() || env.SUPABASE_WORKER_USER_ID || failOwner();
  const ownerFilter = () => isWorkerRequestContext() ? '' : `&${eq('owner_user_id', owner())}`;
  const query = (id) => `?${eq('execution_id', id)}${ownerFilter()}`;
  const toItem = (row) => row && ({ executionId: row.execution_id, requestId: row.request_id, ownerUserId: row.owner_user_id, enqueuedAt: row.enqueued_at, status: row.status, availableAt: row.available_at, leaseId: row.lease_id, leaseExpiresAt: row.lease_expires_at, fenceToken: row.fence_token || 0, attempt: row.attempt || 0, lastFailure: row.last_failure || null });
  const implementation = {
    async enqueue(item) {
      const result = await client.request('translation_queue_items', { method: 'POST', body: [{ owner_user_id: item.ownerUserId || owner(), execution_id: item.executionId, request_id: item.requestId, enqueued_at: item.enqueuedAt, status: item.status || 'queued', available_at: item.availableAt, fence_token: item.fenceToken || 0, attempt: item.attempt || 0, last_failure: item.lastFailure || null }] });
      return toItem(result[0]);
    },
    async dequeue() { const item = await this.peek(); if (item) await this.acknowledge(item.executionId); return item; },
    async peek() { const result = await this.listAvailable(new Date(clock()).toISOString()); return result[0] || null; },
    async list() { const result = await client.request('translation_queue_items', { query: `?select=*${ownerFilter()}&order=enqueued_at.asc` }); return result.map(toItem); },
    async listAvailable(now) { return (await this.list()).filter((item) => item.status === 'queued' && (!item.availableAt || item.availableAt <= now)); },
    async nextAvailableAt() { const item = (await this.list()).find((candidate) => candidate.status === 'queued'); return item?.availableAt || null; },
    async size() { return (await this.list()).filter((item) => item.status === 'queued').length; },
    async clear() { await client.request('translation_queue_items', { method: 'DELETE', query: `?${eq('owner_user_id', owner())}` }); },
    async updateStatus(id, status) { const result = await client.request('translation_queue_items', { method: 'PATCH', query: query(id), body: { status } }); return toItem(result[0]); },
    async acknowledge(id) { await client.request('translation_queue_items', { method: 'DELETE', query: query(id) }); },
    async acknowledgeClaim(id, claim) {
      const result = await client.rpc('translation_queue_acknowledge_claim', {
        p_execution_id: id,
        p_owner_user_id: owner(),
        p_lease_id: claim.leaseId,
        p_fence_token: claim.fenceToken
      });
      return toItem(result[0]);
    },
    async contains(id) { return Boolean((await client.request('translation_queue_items', { query: `${query(id)}&select=execution_id` }))[0]); },
    async claim(id, lease) {
      const result = await client.rpc('translation_queue_claim', {
        p_execution_id: id,
        p_owner_user_id: owner(),
        p_lease_id: lease.leaseId,
        p_lease_expires_at: lease.leaseExpiresAt
      });
      return toItem(result[0]);
    },
    async retryClaim(id, retry) { return this.updateStatus(id, 'queued', retry); },
    async renewClaim(id, claim, lease) {
      const result = await client.rpc('translation_queue_renew_claim', {
        p_execution_id: id,
        p_owner_user_id: owner(),
        p_lease_id: claim.leaseId,
        p_fence_token: claim.fenceToken,
        p_lease_expires_at: lease.leaseExpiresAt,
        p_now: lease.now
      });
      return toItem(result[0]);
    },
    async assertClaimActive(id) { const result = await client.request('translation_queue_items', { query: query(id) }); return toItem(result[0]); },
    async requeueExpiredProcessing(id, now) {
      const result = await client.rpc('translation_queue_requeue_expired', {
        p_execution_id: id,
        p_owner_user_id: owner(),
        p_now: now
      });
      return toItem(result[0]);
    },
    async transferClaimToDeadLetter(id) { return this.updateStatus(id, 'failed'); }
  };
  return createDurableTranslationExecutionQueueRepository(implementation);
}

function failOwner() { const error = new Error('Supabase worker identity is required.'); error.code = 'auth_required'; error.status = 401; throw error; }
