const COMMANDS = new Set(['start', 'pause', 'resume', 'rollover', 'recover', 'stop']);
const STATUSES = new Set(['prepared', 'submitted', 'committed', 'unknown', 'rejected', 'expired']);
const PAYLOAD_FIELDS = Object.freeze({
  start: new Set(['sessionId', 'segmentId']),
  pause: new Set(),
  resume: new Set(),
  rollover: new Set(['nextLiveSessionId']),
  recover: new Set(['failureReason', 'failureCategory']),
  stop: new Set(['failureReason', 'failureCategory'])
});
const RECORD_FIELDS = new Set([
  'schemaVersion', 'type', 'key', 'ownerUserId', 'meetingId', 'sessionId',
  'segmentId', 'originalOperationId', 'currentOperationId', 'command',
  'expectedLifecycleVersion', 'leaseId', 'fenceToken', 'leaseExpiresAt', 'payload', 'status',
  'recoveryOperationId', 'attemptOperationIds', 'createdAt', 'updatedAt'
]);

function required(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} is required.`);
  return value.trim();
}

function optional(value, name) {
  return value == null ? null : required(value, name);
}

export function lifecycleIntentKey(ownerUserId, meetingId, originalOperationId) {
  return `lifecycle:${required(ownerUserId, 'ownerUserId')}:${required(meetingId, 'meetingId')}:${required(originalOperationId, 'originalOperationId')}`;
}

export function projectLifecycleOperationIntent(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((field) => !RECORD_FIELDS.has(field))) {
    throw new TypeError('Lifecycle intent contains unsupported fields.');
  }
  const ownerUserId = required(value.ownerUserId, 'ownerUserId');
  const meetingId = required(value.meetingId, 'meetingId');
  const originalOperationId = required(value.originalOperationId, 'originalOperationId');
  const command = required(value.command, 'command');
  if (!COMMANDS.has(command)) throw new TypeError('Lifecycle intent command is unsupported.');
  if (!STATUSES.has(value.status)) throw new TypeError('Lifecycle intent status is unsupported.');
  if (!Number.isSafeInteger(value.expectedLifecycleVersion) || value.expectedLifecycleVersion < 0) {
    throw new TypeError('Lifecycle intent version is invalid.');
  }
  if (value.fenceToken != null && (!Number.isSafeInteger(value.fenceToken) || value.fenceToken < 0)) {
    throw new TypeError('Lifecycle intent fence is invalid.');
  }
  const payload = value.payload ?? {};
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || Object.entries(payload).some(([field, fieldValue]) =>
      !PAYLOAD_FIELDS[command].has(field) || typeof fieldValue !== 'string'
      || fieldValue.length > 128 || !/^[A-Za-z0-9_-]+$/u.test(fieldValue))) {
    throw new TypeError('Lifecycle intent payload must contain allowed metadata only.');
  }
  const attemptOperationIds = value.attemptOperationIds ?? [];
  if (!Array.isArray(attemptOperationIds)
    || attemptOperationIds.some((id) => typeof id !== 'string' || !id.trim())
    || new Set(attemptOperationIds).size !== attemptOperationIds.length) {
    throw new TypeError('Lifecycle intent attempts are invalid.');
  }
  const key = lifecycleIntentKey(ownerUserId, meetingId, originalOperationId);
  if (value.key != null && value.key !== key) throw new TypeError('Lifecycle intent key does not match its scope.');
  const now = new Date().toISOString();
  return Object.freeze({
    schemaVersion: 1,
    type: 'lifecycle_intent',
    key,
    ownerUserId,
    meetingId,
    sessionId: optional(value.sessionId, 'sessionId'),
    segmentId: optional(value.segmentId, 'segmentId'),
    originalOperationId,
    currentOperationId: required(value.currentOperationId || originalOperationId, 'currentOperationId'),
    command,
    expectedLifecycleVersion: value.expectedLifecycleVersion,
    leaseId: optional(value.leaseId, 'leaseId'),
    fenceToken: value.fenceToken ?? null,
    leaseExpiresAt: optional(value.leaseExpiresAt, 'leaseExpiresAt'),
    payload: Object.freeze({ ...payload }),
    status: value.status,
    recoveryOperationId: optional(value.recoveryOperationId, 'recoveryOperationId'),
    attemptOperationIds: Object.freeze([...attemptOperationIds]),
    createdAt: String(value.createdAt || now),
    updatedAt: String(value.updatedAt || now)
  });
}

export function sameLifecycleIntentIdentity(left, right) {
  return left.ownerUserId === right.ownerUserId
    && left.meetingId === right.meetingId
    && left.originalOperationId === right.originalOperationId
    && left.sessionId === right.sessionId
    && left.segmentId === right.segmentId
    && left.command === right.command
    && left.expectedLifecycleVersion === right.expectedLifecycleVersion
    && JSON.stringify(left.payload) === JSON.stringify(right.payload);
}
