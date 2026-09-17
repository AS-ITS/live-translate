export async function authorizeRecorderRequest({ request, sessionId, sessionShareService, recorderGrantService, recorderLeaseService }) {
  const token = request?.headers?.['x-recorder-token'];
  const code = request?.headers?.['x-recorder-code'];
  const grant = request?.headers?.['x-recorder-grant'];
  const leaseId = request?.headers?.['x-recorder-lease-id'];
  const fenceToken = Number(request?.headers?.['x-recorder-fence-token']);
  const share = code
    ? await sessionShareService?.resolveCode(code)
    : await sessionShareService?.resolveShare(token);
  if (!share || share.role !== 'recorder') throw recorderError('recorder_forbidden');
  if (share.sessionId !== sessionId) throw recorderError('recorder_session_mismatch');
  const record = recorderGrantService?.validate(grant);
  if (!record) throw recorderError('recorder_grant_invalid');
  if (record.sessionId !== sessionId || record.shareId !== share.id) throw recorderError('recorder_session_mismatch');
  if (record.leaseId !== leaseId || record.fenceToken !== fenceToken) throw recorderError('recorder_lease_invalid');
  const lease = await recorderLeaseService?.current(sessionId);
  if (!lease || lease.leaseId !== leaseId || lease.fenceToken !== fenceToken) throw recorderError('recorder_lease_invalid');
  return { share, grant: record, lease };
}

export function hasRecorderHeaders(request) {
  const headers = request?.headers || {};
  return Boolean(headers['x-recorder-token'] || headers['x-recorder-code'] || headers['x-recorder-grant'] || headers['x-recorder-lease-id'] || headers['x-recorder-fence-token']);
}

export async function authorizeAuthenticatedMeetingRecorder({ user, meetingId, meetingMembershipService } = {}) {
  if (!user?.id || user.status === 'disabled') throw recorderError('auth_forbidden');
  if (user.role === 'super_admin') return { userId: user.id, capability: 'meeting_record' };
  if (!await meetingMembershipService?.canRecord?.(meetingId, user.id)) throw recorderError('recorder_forbidden');
  return { userId: user.id, capability: 'meeting_record' };
}

function recorderError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
