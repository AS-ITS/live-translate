const INTERNAL_FIELDS = new Set(['idempotencyKey', 'updatedAt', 'revision', '_operationPayloads']);

export function canonicalCheckpointPayload(checkpoint = {}) {
  const payload = Object.fromEntries(Object.entries(checkpoint)
    .filter(([key]) => !INTERNAL_FIELDS.has(key)));
  if (Array.isArray(payload.durableChunks)) {
    payload.durableChunks = [...payload.durableChunks].sort((a, b) =>
      String(a.stream).localeCompare(String(b.stream)) || a.sequence - b.sequence ||
      String(a.idempotencyKey).localeCompare(String(b.idempotencyKey)));
  }
  if (Array.isArray(payload.finalCues)) {
    payload.finalCues = [...payload.finalCues].sort((a, b) =>
      a.sequence - b.sequence || String(a.cueId).localeCompare(String(b.cueId)));
  }
  return stableStringify(payload);
}

export function checkpointOperationKey(segmentId, checkpoint) {
  const canonical = canonicalCheckpointPayload(checkpoint);
  const mask = (1n << 64n) - 1n;
  let left = 0xcbf29ce484222325n;
  let right = 0x84222325cbf29ce4n;
  for (let index = 0; index < canonical.length; index += 1) {
    const code = BigInt(canonical.charCodeAt(index));
    left = ((left ^ code) * 0x100000001b3n) & mask;
    right = ((right ^ code) * 0x100000001b3n) & mask;
  }
  return `checkpoint:${segmentId}:${left.toString(16).padStart(16, '0')}${right.toString(16).padStart(16, '0')}`;
}

export function checkpointConflict(message) {
  const error = new Error(message);
  error.code = 'checkpoint_conflict';
  error.status = 409;
  return error;
}

export function checkCheckpointOperation(existing, incoming) {
  const key = incoming.idempotencyKey;
  const canonical = canonicalCheckpointPayload(incoming);
  const operations = existing?._operationPayloads || {};
  if (Object.hasOwn(operations, key)) {
    if (operations[key] !== canonical) throw checkpointConflict(`checkpoint key changed payload: ${key}`);
    return { duplicate: true, canonical };
  }
  if (existing?.idempotencyKey === key) {
    // A legacy checkpoint did not record its original operation payload.
    throw checkpointConflict(`checkpoint key has unknown legacy payload: ${key}`);
  }
  return { duplicate: false, canonical };
}

export function recordCheckpointOperation(existing, incoming, merged, canonical) {
  return {
    ...merged,
    revision: (Number.isSafeInteger(existing?.revision) ? existing.revision : 0) + 1,
    _operationPayloads: { ...(existing?._operationPayloads || {}), [incoming.idempotencyKey]: canonical }
  };
}

export function assertCheckpointPreservedOnGenericUpdate(existing, next) {
  if ((existing?.revision || 0) > 0 && stableStringify(existing) !== stableStringify(next)) {
    throw checkpointConflict('checkpoint mutation requires the atomic checkpoint operation');
  }
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
