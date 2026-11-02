import { createSupabaseServiceRoleClient } from './supabaseRestClient.js';

const EXPECTED_CODES = new Set([
  'invalid_request',
  'meeting_not_found',
  'meeting_terminal',
  'meeting_lifecycle_conflict',
  'recorder_already_active',
  'recorder_lease_invalid',
  'recorder_takeover_confirmation_required',
  'auth_forbidden'
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
      }).then(projectLifecycleMetadataResult);
    },

    lookupOperation(input = {}) {
      return invoke('lookup_meeting_lifecycle_operation', {
        p_owner_user_id: required(input.ownerUserId, 'ownerUserId'),
        p_meeting_id: required(input.meetingId, 'meetingId'),
        p_operation_id: required(input.operationId, 'operationId'),
        p_principal_type: required(input.principalType, 'principalType'),
        p_principal_id: required(input.principalId, 'principalId')
      });
    },

    recoverLease(input = {}) {
      return invoke('recover_meeting_recorder_lease', {
        p_owner_user_id: required(input.ownerUserId, 'ownerUserId'),
        p_meeting_id: required(input.meetingId, 'meetingId'),
        p_original_operation_id: required(input.originalOperationId, 'originalOperationId'),
        p_recovery_operation_id: required(input.recoveryOperationId, 'recoveryOperationId'),
        p_command: required(input.command, 'command'),
        p_expected_lifecycle_version: nonNegativeInteger(input.expectedLifecycleVersion, 'expectedLifecycleVersion'),
        p_session_id: required(input.sessionId, 'sessionId'),
        p_segment_id: optional(input.segmentId),
        p_prior_lease_id: optional(input.priorLeaseId),
        p_prior_fence_token: optionalNonNegativeInteger(input.priorFenceToken, 'priorFenceToken'),
        p_principal_type: required(input.principalType, 'principalType'),
        p_principal_id: required(input.principalId, 'principalId')
      });
    },

    renewLease(input = {}) {
      return invoke('renew_meeting_recorder_lease', leasePayload(input));
    },

    touchLiveness(input = {}) {
      return invoke('touch_meeting_liveness', leasePayload(input));
    },

    expireStaleMeetings({ limit = 3 } = {}) {
      return invoke('expire_stale_meetings', {
        p_limit: boundedPositiveInteger(limit, 'limit', 10)
      });
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
        error.status = code === 'meeting_not_found' ? 404 : (code === 'invalid_request' ? 400 : (code === 'auth_forbidden' ? 403 : 409));
      }
      throw error;
    }
  }
}

function projectLifecycleMetadataResult(result) {
  if (!result || typeof result !== 'object') return result;
  const projected = { ...result };
  if (projected.meeting && typeof projected.meeting === 'object') {
    const meeting = projected.meeting;
    projected.meeting = {
      id: meeting.id,
      status: meeting.status,
      lifecycle_version: meeting.lifecycle_version ?? meeting.lifecycleVersion
    };
  }
  if (projected.session && typeof projected.session === 'object') {
    const session = projected.session;
    projected.session = {
      id: session.id,
      meeting_id: session.meeting_id ?? session.meetingId,
      status: session.status,
      current_segment_id: session.current_segment_id ?? session.currentSegmentId ?? null
    };
  }
  if (projected.segment && typeof projected.segment === 'object') {
    const segment = projected.segment;
    projected.segment = {
      id: segment.id,
      session_id: segment.session_id ?? segment.sessionId,
      status: segment.status,
      sequence: segment.sequence,
      live_session_id: segment.live_session_id ?? segment.liveSessionId ?? null
    };
  }
  if (projected.lease && typeof projected.lease === 'object') {
    projected.lease = {
      leaseId: projected.lease.leaseId,
      fenceToken: projected.lease.fenceToken,
      expiresAt: projected.lease.expiresAt
    };
  }
  return projected;
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

function boundedPositiveInteger(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} must be an integer from 1 to ${maximum}.`);
  }
  return value;
}
