import { createSupabaseServiceRoleClient } from './supabaseRestClient.js';

export function createSupabaseReadinessCheck({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const client = createSupabaseServiceRoleClient({ env, fetchImpl });
  if (!client) return async () => false;
  return async function check() {
    await client.healthCheck({ tables: ['observability_metric_buckets'] });
    await client.rpc('record_observability_metric', {
      p_bucket_start: new Date(0).toISOString(), p_instance_id: 'readiness', p_metric_name: 'readiness_probe',
      p_provider: 'none', p_status_class: 'none', p_count: 0, p_sum_value: 0, p_max_value: 0
    });
    return true;
  };
}
