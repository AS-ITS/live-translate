import { createSupabaseServiceRoleClient, eq } from './supabaseRestClient.js';

export function createSupabaseMeetingPurgeRepository({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const client = createSupabaseServiceRoleClient({ env, fetchImpl });
  if (!client) return null;

  return Object.freeze({
    async claimDue({ workerId, limit }) {
      const result = await client.rpc('claim_due_meeting_purges', {
        p_worker_id: workerId,
        p_limit: limit
      });
      return Array.isArray(result) ? result : [];
    },

    async listArtifacts({ ownerUserId, meetingId }) {
      const [audioRows, exportRows] = await Promise.all([
        client.request('audio_artifacts', {
          query: `?select=storage_path&${eq('owner_user_id', ownerUserId)}&${eq('meeting_id', meetingId)}`
        }),
        client.request('export_artifacts', {
          query: `?select=storage_path&${eq('owner_user_id', ownerUserId)}&${eq('meeting_id', meetingId)}`
        })
      ]);
      return {
        audioPaths: audioRows.map((row) => row.storage_path).filter(Boolean),
        exportPaths: exportRows.map((row) => row.storage_path).filter(Boolean)
      };
    },

    async deleteMeeting({ ownerUserId, meetingId }) {
      await client.request('meetings', {
        method: 'DELETE',
        query: `?${eq('id', meetingId)}&${eq('owner_user_id', ownerUserId)}`
      });
      return true;
    },

    async markFailed({ claim, error }) {
      await client.request('meetings', {
        method: 'PATCH',
        query: `?${eq('id', claim.meetingId)}&${eq('owner_user_id', claim.ownerUserId)}`,
        body: {
          purge_status: 'failed',
          purge_claimed_at: null,
          purge_claimed_by: null,
          purge_last_error: safeError(error)
        }
      });
      return true;
    }
  });
}

function safeError(error) {
  const code = typeof error?.code === 'string' ? error.code : 'purge_failed';
  return code.replace(/[^a-z0-9_:-]/giu, '_').slice(0, 120);
}
