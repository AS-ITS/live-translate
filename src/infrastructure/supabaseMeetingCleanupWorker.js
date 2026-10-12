import { randomUUID } from 'node:crypto';
import { createSupabaseServiceRoleClient } from './supabaseRestClient.js';

const MAX_STORAGE_OBJECTS = 20;
const MAX_DATABASE_ROWS = 50;
const REQUEST_TIMEOUT_MS = 1200;
const MAX_RUN_MS = 3000;

export function createSupabaseMeetingCleanupWorker({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const baseUrl = String(env.SUPABASE_URL || '').replace(/\/$/u, '');
  const key = env.SUPABASE_SECRET_KEY;
  let runStartedAt = 0;
  const timedFetch = (url, options = {}) => {
    const remaining = MAX_RUN_MS - (Date.now() - runStartedAt);
    if (remaining <= 0) throw new Error('cleanup_time_budget_exhausted');
    return fetchImpl(url, { ...options,
      signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, remaining)) });
  };
  const client = createSupabaseServiceRoleClient({
    env,
    fetchImpl: timedFetch,
    getRetryAttempts: 1
  });
  if (!client || !baseUrl || !key) return null;

  return Object.freeze({
    async runOnce() {
      runStartedAt = Date.now();
      const workerId = randomUUID();
      let claim;
      try {
        [claim] = await client.rpc('claim_due_recording_cleanup', { p_worker: workerId });
        if (!claim) return { claimed: 0, cleared: 0, rows: 0, objects: 0 };
        if (claim.phase === 'storage') {
          const objects = await client.rpc('list_meeting_storage_paths', {
            p_owner_user_id: claim.owner_user_id,
            p_meeting_id: claim.meeting_id,
            p_limit: MAX_STORAGE_OBJECTS + 1
          });
          const batch = objects.slice(0, MAX_STORAGE_OBJECTS);
          for (const bucket of ['meeting-audio', 'meeting-exports']) {
            const paths = batch.filter((item) => item.bucket === bucket).map((item) => item.path);
            if (!paths.length) continue;
            const response = await timedFetch(`${baseUrl}/storage/v1/object/${bucket}`, {
              method: 'DELETE',
              headers: {
                apikey: key,
                Authorization: `Bearer ${key}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({ prefixes: paths })
            });
            if (!response.ok) throw new Error(`Storage ${bucket} cleanup failed: ${response.status}`);
          }
          await client.rpc('advance_recording_cleanup', {
            p_recording_id: claim.recording_id,
            p_worker: workerId,
            p_next_phase: objects.length <= MAX_STORAGE_OBJECTS ? 'outputs' : 'storage'
          });
          return { claimed: 1, cleared: 0, rows: 0, objects: batch.length };
        }
        const rows = await client.rpc('purge_recording_content_batch', {
          p_recording_id: claim.recording_id,
          p_worker: workerId,
          p_limit: MAX_DATABASE_ROWS
        });
        return { claimed: 1, cleared: claim.phase === 'sessions' && rows === 0 ? 1 : 0, rows, objects: 0 };
      } catch (error) {
        if (claim && Date.now() - runStartedAt < MAX_RUN_MS - 100) {
          try {
            await client.rpc('advance_recording_cleanup', {
              p_recording_id: claim.recording_id,
              p_worker: workerId,
              p_next_phase: claim.phase,
              p_error: error?.code || 'cleanup_failed'
            });
          } catch {
            // The 45-second claim lease makes an interrupted attempt recoverable.
          }
        }
        return { claimed: claim ? 1 : 0, cleared: 0, rows: 0, objects: 0, failed: 1 };
      }
    }
  });
}
