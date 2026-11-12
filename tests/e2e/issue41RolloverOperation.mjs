import assert from 'node:assert/strict';

export function assertCommittedLocalRolloverOperation(operation, recording, {
  meetingId, recordingId, oldSegmentId, oldSegmentNumber, newSegmentId, newSegmentNumber
}) {
  const suffix = `:${newSegmentNumber}`;
  assert.ok(newSegmentId.startsWith('segment:') && newSegmentId.endsWith(suffix), 'successor segment identity');
  const sessionId = newSegmentId.slice('segment:'.length, -suffix.length);
  assert.ok(sessionId, 'successor session identity');
  const operationId = `rollover:${sessionId}:${oldSegmentId}`;

  assert.ok(operation && typeof operation === 'object', 'durable local rollover operation exists');
  assert.equal(operation.schemaVersion, 2, 'v2 transition schema');
  assert.equal(operation.type, 'local_segment_transition', 'v2 transition type');
  assert.equal(operation.phase, 'COMMITTED', 'transition committed');
  assert.equal(operation.operationId, operationId, 'durable operation ID');
  assert.equal(operation.key, `${meetingId}\u0000${operationId}`, 'persisted operation key');
  assert.equal(operation.meetingId, meetingId);
  assert.equal(operation.recordingId, recordingId);
  assert.equal(operation.predecessorId, oldSegmentId);
  assert.equal(operation.predecessorSequence, oldSegmentNumber);
  assert.equal(operation.successorId, newSegmentId);
  assert.equal(operation.successorSequence, newSegmentNumber);
  assert.equal(operation.boundary?.recordingId, recordingId, 'PCM boundary recording');
  assert.equal(operation.boundary?.transitionOperationId, operationId, 'PCM boundary operation');

  const result = operation.result;
  assert.ok(result && typeof result === 'object', 'committed transition result exists');
  assert.equal(result.integrityVersion, 2, 'v2 recording result');
  assert.equal(result.meetingId, meetingId);
  assert.equal(result.recordingId, recordingId);
  assert.equal(result.segmentId, newSegmentId);
  assert.equal(result.segmentNumber, newSegmentNumber);
  assert.ok(Number.isSafeInteger(result.captureEpoch) && result.captureEpoch > 0, 'result capture epoch');
  assert.ok(Number.isSafeInteger(result.providerEpoch) && result.providerEpoch > 0, 'result provider epoch');
  assert.ok(recording && typeof recording === 'object', 'IndexedDB recording exists');
  for (const field of ['meetingId', 'recordingId', 'segmentId', 'segmentNumber', 'captureEpoch', 'providerEpoch', 'state']) {
    assert.equal(result[field], recording[field], `committed result matches IndexedDB recording ${field}`);
  }
}
