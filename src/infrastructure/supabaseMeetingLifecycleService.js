import { createSupabaseServiceRoleClient } from './supabaseRestClient.js';

const EXPECTED_CODES = new Set([
  'invalid_request',
  'meeting_not_found',
  'meeting_lifecycle_conflict',
  'recorder_already_active',
  'recorder_lease_invalid',
  'recorder_takeover_confirmation_required'
]);

export function createSupabaseMeetingLifecycleService({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const client = createSupabaseServiceRoleClient({ env, fetchImpl });
  if (!client) return null;

  return Object.freeze({
    execute(input = {}) {
      return invoke('execute_meeting_lifecycle_command', {
        p_owner_user_id: required(input.ownerUserId, 'ownerUserId'),
        p_meeting_id: required(input.meetingId, 'meetingId'),
        p_command: required(input.command, 'command'),
        p_operation_id: required(input.operationId, 'operationId'),
        p_expected_lifecycle_version: nonNegativeInteger(input.expectedLifecycleVersion, 'expectedLifecycleVersion'),
        p_principal_type: required(input.principalType, 'principalType'),
        p_principal_id: required(input.principalId, 'principalId'),
        p_lease_id: optional(input.leaseId),
        p_fence_token: optionalNonNegativeInteger(input.fenceToken, 'fenceToken'),
        p_force_allowed: input.forceAllowed === true,
        p_payload: input.payload && typeof input.payload === 'object' ? input.payload : {}
      });
    },

    renewLease(input = {}) {
      return invoke('renew_meeting_recorder_lease', leasePayload(input));
    },

    touchLiveness(input = {}) {
      return invoke('touch_meeting_liveness', leasePayload(input));
    },

    validateWrite(input = {}) {
      return invoke('validate_meeting_recorder_write', {
        p_meeting_id: required(input.meetingId, 'meetingId'),
        p_session_id: optional(input.sessionId),
        p_segment_id: optional(input.segmentId),
        p_lease_id: optional(input.leaseId),
        p_fence_token: optionalNonNegativeInteger(input.fenceToken, 'fenceToken')
      });
    }
  });

  async function invoke(name, body) {
    try {
      const result = await client.rpc(name, body);
      return Array.isArray(result) ? result[0] : result;
    } catch (error) {
      const code = expectedCode(error?.supabaseMessage);
      if (code) {
        error.code = code;
        error.status = code === 'meeting_not_found' ? 404 : (code === 'invalid_request' ? 400 : 409);
      }
      throw error;
    }
  }
}

function leasePayload(input) {
  return {
    p_owner_user_id: required(input.ownerUserId, 'ownerUserId'),
    p_meeting_id: required(input.meetingId, 'meetingId'),
    p_principal_type: required(input.principalType, 'principalType'),
    p_principal_id: required(input.principalId, 'principalId'),
    p_lease_id: required(input.leaseId, 'leaseId'),
    p_fence_token: nonNegativeInteger(input.fenceToken, 'fenceToken')
  };
}

function expectedCode(message) {
  const value = String(message || '').trim();
  return EXPECTED_CODES.has(value) ? value : null;
}

function required(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} is required.`);
  return value.trim();
}

function optional(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function nonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative integer.`);
  return value;
}

function optionalNonNegativeInteger(value, name) {
  return value === null || value === undefined ? null : nonNegativeInteger(value, name);
}
