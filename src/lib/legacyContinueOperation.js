function required(value, name) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new TypeError(`${name} is required.`);
  return normalized;
}

function optional(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function stableCheckpoint(value = {}) {
  const checkpoint = value && typeof value === 'object' ? value : {};
  return {
    lastFinalCueSequence: Number.isSafeInteger(checkpoint.lastFinalCueSequence)
      ? checkpoint.lastFinalCueSequence
      : 0,
    finalCues: Array.isArray(checkpoint.finalCues) ? checkpoint.finalCues : [],
    durableChunks: Array.isArray(checkpoint.durableChunks) ? checkpoint.durableChunks : [],
    cueCheckpoint: checkpoint.cueCheckpoint && typeof checkpoint.cueCheckpoint === 'object'
      ? checkpoint.cueCheckpoint
      : null
  };
}

export function createLegacyContinuePayload(input = {}) {
  return Object.freeze({
    meetingId: required(input.meetingId, 'meetingId'),
    sourceSegmentId: required(input.sourceSegmentId, 'sourceSegmentId'),
    nextLiveSessionId: required(input.nextLiveSessionId, 'nextLiveSessionId'),
    expectedSessionId: optional(input.expectedSessionId),
    checkpoint: stableCheckpoint(input.checkpoint)
  });
}

export function serializeLegacyContinuePayload(input = {}) {
  return JSON.stringify(createLegacyContinuePayload(input));
}

export async function createLegacyContinuePayloadHash(input = {}, cryptoImpl = globalThis.crypto) {
  if (!cryptoImpl?.subtle) throw new TypeError('Web Crypto is required.');
  const bytes = new TextEncoder().encode(serializeLegacyContinuePayload(input));
  const digest = await cryptoImpl.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function createLegacyContinueOperation(input = {}) {
  const payload = createLegacyContinuePayload(input);
  const operationId = required(input.operationId, 'operationId');
  const payloadHash = required(input.payloadHash, 'payloadHash');
  const timestamp = input.timestamp || new Date().toISOString();
  return Object.freeze({
    schemaVersion: 1,
    key: `${payload.meetingId}\u0000${operationId}`,
    type: 'legacy_continue',
    operationId,
    ...payload,
    payloadHash,
    attempt: Number.isSafeInteger(input.attempt) && input.attempt >= 0 ? input.attempt : 0,
    state: input.state || 'pending',
    committedSuccessor: input.committedSuccessor || null,
    createdAt: input.createdAt || timestamp,
    updatedAt: timestamp
  });
}
