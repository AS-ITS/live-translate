import { createSupabaseServiceRoleClient, eq } from './supabaseRestClient.js';

export function createSupabaseMeetingDeletionRepository({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const client = createSupabaseServiceRoleClient({ env, fetchImpl });
  if (!client) return null;
  const baseUrl = String(env.SUPABASE_URL || '').replace(/\/$/u, '');
  const secretKey = env.SUPABASE_SECRET_KEY;

  return Object.freeze({
    async getTombstone(meetingId) {
      const rows = await client.request('meeting_deletions', {
        query: `?select=owner_user_id,state,deleted_at&${eq('meeting_id', meetingId)}&limit=1`
      });
      return rows[0] ? {
        ownerUserId: rows[0].owner_user_id,
        state: rows[0].state,
        deletedAt: rows[0].deleted_at
      } : null;
    },
    async begin({ meetingId, actorUserId }) {
      try {
        return await client.rpc('begin_meeting_deletion', {
          p_meeting_id: meetingId,
          p_actor_user_id: actorUserId
        });
      } catch (error) {
        throw mapDeletionError(error);
      }
    },
    async finish({ meetingId, actorUserId }) {
      try {
        return await client.rpc('finish_meeting_deletion', {
          p_meeting_id: meetingId,
          p_actor_user_id: actorUserId
        });
      } catch (error) {
        throw mapDeletionError(error);
      }
    },
    async removeStorageBatch({ meetingId, ownerUserId, limit = 100 }) {
      const objects = await client.rpc('list_meeting_storage_paths', {
        p_owner_user_id: ownerUserId,
        p_meeting_id: meetingId,
        p_limit: limit + 1
      });
      const batch = objects.slice(0, limit);
      for (const bucket of ['meeting-audio', 'meeting-exports']) {
        const paths = batch.filter((object) => object.bucket === bucket).map((object) => object.path);
        if (paths.length === 0) continue;
        const response = await fetchImpl(`${baseUrl}/storage/v1/object/${bucket}`, {
          method: 'DELETE',
          headers: {
            apikey: secretKey,
            Authorization: `Bearer ${secretKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ prefixes: paths })
        });
        if (!response.ok) {
          const error = new Error('Meeting Storage deletion failed.');
          error.code = 'meeting_storage_delete_failed';
          error.status = 503;
          throw error;
        }
      }
      return { complete: objects.length <= limit, removed: batch.length };
    }
  });
}

function mapDeletionError(error) {
  const code = error?.supabaseMessage;
  if (['meeting_not_found', 'auth_forbidden', 'meeting_delete_active_not_allowed', 'meeting_deleted'].includes(code)) {
    error.code = code;
    error.status = code === 'meeting_not_found' ? 404 : code === 'auth_forbidden' ? 403 : 409;
  }
  return error;
}
