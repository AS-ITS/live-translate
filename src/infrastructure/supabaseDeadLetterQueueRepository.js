import { currentRequestOwnerId } from '../../server/requestIdentity.js';
import { createDeadLetterQueueRepository } from '../application/translation/deadLetterQueueRepository.js';
import { createSupabaseServiceRoleClient, eq } from './supabaseRestClient.js';

export function createSupabaseDeadLetterQueueRepository({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const client = createSupabaseServiceRoleClient({ env, fetchImpl });
  if (!client) return null;
  const owner = () => currentRequestOwnerId() || env.SUPABASE_WORKER_USER_ID || failOwner();
  const map = (row) => ({ executionId: row.execution_id, requestId: row.request_id, attempt: row.attempt, availableAt: row.available_at, lastFailure: row.last_failure, failedAt: row.failed_at, failure: row.failure, ...(row.provider_key ? { providerKey: row.provider_key } : {}), ...(row.provider_metadata ? { providerMetadata: row.provider_metadata } : {}), ...(row.execution_metadata ? { executionMetadata: row.execution_metadata } : {}) });
  return createDeadLetterQueueRepository({
    async enqueue(item) { await client.request('translation_dead_letter_items', { method: 'POST', body: [{ owner_user_id: owner(), execution_id: item.executionId, request_id: item.requestId, attempt: item.attempt, available_at: item.availableAt, last_failure: item.lastFailure, failed_at: item.failedAt, failure: item.failure, provider_key: item.providerKey, provider_metadata: item.providerMetadata, execution_metadata: item.executionMetadata }] }); },
    async list() { const rows = await client.request('translation_dead_letter_items', { query: `?select=*&${eq('owner_user_id', owner())}&order=failed_at.asc` }); return rows.map(map); },
    async size() { return (await this.list()).length; },
    async clear() { await client.request('translation_dead_letter_items', { method: 'DELETE', query: `?${eq('owner_user_id', owner())}` }); }
  });
}
function failOwner() { const error = new Error('Supabase worker identity is required.'); error.code = 'auth_required'; error.status = 401; throw error; }
