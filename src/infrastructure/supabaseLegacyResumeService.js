import { createSupabaseServiceRoleClient } from './supabaseRestClient.js';

const EXPECTED_CODES = new Set([
  'invalid_request',
  'meeting_not_found',
  'meeting_terminal',
  'meeting_lifecycle_conflict',
  'meeting_segment_not_found',
  'meeting_segment_invalid_state',
  'checkpoint_conflict'
]);

export function createSupabaseLegacyResumeService({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const client = createSupabaseServiceRoleClient({ env, fetchImpl });
  if (!client) return null;
  const rpc = (name, body) => client.rpc(name, body);

  return Object.freeze({
    execute(input = {}) {
      return invoke(rpc, 'resume_legacy_meeting_segment', {
        p_owner_user_id: required(input.ownerUserId, 'ownerUserId'),
        p_meeting_id: required(input.meetingId, 'meetingId'),
        p_source_segment_id: required(input.sourceSegmentId, 'sourceSegmentId'),
        p_operation_id: required(input.operationId, 'operationId'),
        p_payload_hash: required(input.payloadHash, 'payloadHash'),
        p_next_live_session_id: required(input.nextLiveSessionId, 'nextLiveSessionId'),
        p_expected_session_id: optional(input.expectedSessionId),
        p_checkpoint: input.checkpoint && typeof input.checkpoint === 'object' ? input.checkpoint : {},
        p_global_glossary_entries: Array.isArray(input.globalGlossaryEntries) ? input.globalGlossaryEntries : []
      });
    },
    getOperation(input = {}) {
      return invoke(rpc, 'get_legacy_resume_operation', {
        p_owner_user_id: required(input.ownerUserId, 'ownerUserId'),
        p_meeting_id: required(input.meetingId, 'meetingId'),
        p_operation_id: required(input.operationId, 'operationId')
      });
    }
  });
}

async function invoke(rpc, name, body) {
  try {
    const result = await rpc(name, body);
    return Array.isArray(result) ? result[0] : result;
  } catch (error) {
    const code = [...EXPECTED_CODES].find((candidate) => String(error?.supabaseMessage || '').includes(candidate));
    if (code) {
      error.code = code;
      error.status = code === 'meeting_not_found' || code === 'meeting_segment_not_found'
        ? 404
        : code === 'invalid_request' ? 400 : code === 'meeting_terminal' ? 410 : 409;
    }
    throw error;
  }
}

function required(value, name) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new TypeError(`${name} is required.`);
  return normalized;
}

function optional(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}
