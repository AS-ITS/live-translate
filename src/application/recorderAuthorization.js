export async function authorizeRecorderRequest({ request, sessionId, sessionShareService, recorderGrantService, recorderLeaseService }) {
  const token = request?.headers?.['x-recorder-token'];
  const grant = request?.headers?.['x-recorder-grant'];
  const leaseId = request?.headers?.['x-recorder-lease-id'];
  const fenceToken = Number(request?.headers?.['x-recorder-fence-token']);
  const share = await sessionShareService?.resolveShare(token);
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
  return Boolean(headers['x-recorder-token'] || headers['x-recorder-grant'] || headers['x-recorder-lease-id'] || headers['x-recorder-fence-token']);
}

function recorderError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
