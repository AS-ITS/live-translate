import { createSupabaseServiceRoleClient } from './supabaseRestClient.js';

export function createSupabaseReadinessCheck({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const client = createSupabaseServiceRoleClient({ env, fetchImpl });
  if (!client) return async () => false;
  return async function check() {
    await client.healthCheck({
      tables: [
        'profiles',
        'meetings',
        'meeting_segments',
        'sessions',
        'subtitle_cues',
        'export_artifacts',
        'meeting_members',
        'viewer_shares',
        'audio_artifacts',
        'observability_metric_buckets'
      ],
      rpcFunctions: [
        {
          name: 'record_observability_metric',
          body: {
            p_bucket_start: new Date(0).toISOString(),
            p_instance_id: 'readiness',
            p_metric_name: 'readiness_probe',
            p_provider: 'none',
            p_status_class: 'none',
            p_count: 0,
            p_sum_value: 0,
            p_max_value: 0
          }
        },
        {
          name: 'translation_queue_claim',
          body: {
            p_execution_id: 'readiness-probe',
            p_owner_user_id: '00000000-0000-0000-0000-000000000000',
            p_lease_id: 'readiness-probe',
            p_lease_expires_at: new Date(0).toISOString()
          }
        },
        {
          name: 'translation_queue_acknowledge_claim',
          body: {
            p_execution_id: 'readiness-probe',
            p_owner_user_id: '00000000-0000-0000-0000-000000000000',
            p_lease_id: 'readiness-probe',
            p_fence_token: 0
          }
        },
        {
          name: 'translation_queue_renew_claim',
          body: {
            p_execution_id: 'readiness-probe',
            p_owner_user_id: '00000000-0000-0000-0000-000000000000',
            p_lease_id: 'readiness-probe',
            p_fence_token: 0,
            p_lease_expires_at: new Date(0).toISOString(),
            p_now: new Date(0).toISOString()
          }
        },
        {
          name: 'translation_queue_requeue_expired',
          body: {
            p_execution_id: 'readiness-probe',
            p_owner_user_id: '00000000-0000-0000-0000-000000000000',
            p_now: new Date(0).toISOString()
          }
        }
      ],
      storageBuckets: ['meeting-audio', 'meeting-exports']
    });
    return true;
  };
}
