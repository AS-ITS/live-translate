import assert from 'node:assert/strict';
import test from 'node:test';
import { assertCommittedLocalRolloverOperation } from '../e2e/issue41RolloverOperation.mjs';

const expected = {
  meetingId: 'meeting-1', recordingId: 'recording-1',
  oldSegmentId: 'initial-segment', oldSegmentNumber: 1,
  newSegmentId: 'segment:session-1:2', newSegmentNumber: 2
};
const operationId = 'rollover:session-1:initial-segment';

function committedTransition() {
  const recording = {
    meetingId: expected.meetingId, recordingId: expected.recordingId,
    segmentId: expected.newSegmentId, segmentNumber: 2,
    integrityVersion: 2, captureEpoch: 2, providerEpoch: 1, state: 'capturing'
  };
  return {
    recording,
    operation: {
      schemaVersion: 2, key: `${expected.meetingId}\u0000${operationId}`,
      type: 'local_segment_transition', phase: 'COMMITTED', operationId,
      meetingId: expected.meetingId, recordingId: expected.recordingId,
      predecessorId: expected.oldSegmentId, predecessorSequence: 1,
      successorId: expected.newSegmentId, successorSequence: 2,
      boundary: { recordingId: expected.recordingId, transitionOperationId: operationId },
      result: { ...recording }
    }
  };
}

test('accepts a committed v2 transition matching the IndexedDB recording', () => {
  const { operation, recording } = committedTransition();
  assert.doesNotThrow(() => assertCommittedLocalRolloverOperation(operation, recording, expected));
});

test('rejects legacy, pending, failed and aborted operations', () => {
  for (const change of [
    { type: 'local_segment_rollover' },
    { phase: 'PREPARED' },
    { phase: 'FAILED' },
    { phase: 'ABORTED' }
  ]) {
    const { operation, recording } = committedTransition();
    assert.throws(() => assertCommittedLocalRolloverOperation({ ...operation, ...change }, recording, expected));
  }
});

test('rejects wrong successor and missing or inconsistent operation ID', () => {
  for (const change of [
    { successorId: 'segment:session-1:3' },
    { operationId: undefined },
    { operationId: 'rollover:other:initial-segment' },
    { key: `${expected.meetingId}\u0000wrong` }
  ]) {
    const { operation, recording } = committedTransition();
    assert.throws(() => assertCommittedLocalRolloverOperation({ ...operation, ...change }, recording, expected));
  }
});

test('rejects missing result, identity, boundary or mismatched IndexedDB recording', () => {
  for (const change of [
    { result: null },
    { recordingId: undefined },
    { boundary: null },
    { result: { ...committedTransition().recording, segmentId: 'wrong' } }
  ]) {
    const { operation, recording } = committedTransition();
    assert.throws(() => assertCommittedLocalRolloverOperation({ ...operation, ...change }, recording, expected));
  }
  const { operation, recording } = committedTransition();
  assert.throws(() => assertCommittedLocalRolloverOperation(operation, { ...recording, providerEpoch: 2 }, expected));
});
