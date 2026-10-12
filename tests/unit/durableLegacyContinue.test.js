import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { establishDurableLegacyContinue } from '../../src/lib/durableLegacyContinue.js';
import { createInMemoryLocalMeetingManifestStore } from '../../src/lib/localMeetingStorage.js';

const checkpoint = Object.freeze({
  lastFinalCueSequence: 1,
  finalCues: [{ id: 'cue-1', segmentId: 'segment-1' }],
  durableChunks: [],
  cueCheckpoint: { segmentId: 'segment-1' }
});

test('legacy Continue survives a lost ACK and reload without creating a second successor', async () => {
  const persistence = createInMemoryLocalMeetingManifestStore();
  let commits = 0;
  let committed = null;
  const api = {
    async getLegacyResumeOperation() {
      if (!committed) {
        const error = new Error('missing');
        error.status = 404;
        throw error;
      }
      return { ...committed, replayed: true };
    },
    async resumeLegacySegment(input) {
      commits += 1;
      committed = {
        meeting: { id: input.meetingId },
        segment: { id: 'segment-2', sequence: 2 },
        operation: { payloadHash: input.payloadHash, sourceSegmentId: input.sourceSegmentId },
        effectiveGlossaryRevision: 'revision-b'
      };
      const error = new Error('response lost');
      error.status = 503;
      throw error;
    }
  };
  try {
    const first = await establishDurableLegacyContinue({
      persistence,
      api,
      meetingId: 'meeting-1',
      sourceSegmentId: 'segment-1',
      expectedSessionId: 'session-1',
      checkpoint,
      cryptoImpl: webcrypto,
      operationIdFactory: () => 'continue-1',
      liveSessionIdFactory: () => 'live-2'
    });
    const afterReload = await establishDurableLegacyContinue({
      persistence,
      api,
      meetingId: 'meeting-1',
      sourceSegmentId: 'segment-1',
      expectedSessionId: 'session-1',
      checkpoint,
      cryptoImpl: webcrypto,
      operationIdFactory: () => 'must-not-be-used',
      liveSessionIdFactory: () => 'must-not-be-used'
    });
    assert.equal(commits, 1);
    assert.equal(first.operation.operationId, 'continue-1');
    assert.equal(afterReload.operation.operationId, 'continue-1');
    assert.equal(afterReload.result.segment.id, 'segment-2');
  } finally {}
});

test('pending Continue rejects a changed source Segment', async () => {
  const persistence = createInMemoryLocalMeetingManifestStore();
  const unavailableApi = {
    async getLegacyResumeOperation() {
      const error = new Error('offline');
      error.status = 503;
      throw error;
    },
    async resumeLegacySegment() { throw new Error('unreachable'); }
  };
  try {
    await assert.rejects(establishDurableLegacyContinue({
      persistence,
      api: unavailableApi,
      meetingId: 'meeting-1',
      sourceSegmentId: 'segment-1',
      checkpoint,
      cryptoImpl: webcrypto,
      operationIdFactory: () => 'continue-1',
      liveSessionIdFactory: () => 'live-2'
    }));
    await assert.rejects(establishDurableLegacyContinue({
      persistence,
      api: unavailableApi,
      meetingId: 'meeting-1',
      sourceSegmentId: 'segment-other',
      checkpoint,
      cryptoImpl: webcrypto,
      operationIdFactory: () => 'continue-2',
      liveSessionIdFactory: () => 'live-3'
    }), { code: 'meeting_segment_invalid_state' });
  } finally {}
});

test('reconciliation rejects a committed result with a different payload hash', async () => {
  const persistence = createInMemoryLocalMeetingManifestStore();
  await persistence.saveContinueOperation({
    operationId: 'continue-1', meetingId: 'meeting-1', sourceSegmentId: 'segment-1',
    nextLiveSessionId: 'live-2', payloadHash: 'expected-hash', checkpoint, state: 'pending'
  });
  const api = {
    async getLegacyResumeOperation() {
      return {
        operation: { payloadHash: 'different-hash', sourceSegmentId: 'segment-1' },
        segment: { id: 'segment-2' }
      };
    },
    async resumeLegacySegment() { throw new Error('must not execute'); }
  };
  await assert.rejects(establishDurableLegacyContinue({
    persistence,
    api,
    meetingId: 'meeting-1',
    sourceSegmentId: 'segment-1',
    checkpoint,
    cryptoImpl: webcrypto,
    operationIdFactory: () => 'continue-2',
    liveSessionIdFactory: () => 'live-3'
  }), { code: 'meeting_lifecycle_conflict' });
});

test('503 before commit reconciles source then retries the same operation and live session identity', async () => {
  const persistence = createInMemoryLocalMeetingManifestStore();
  const calls = [];
  let attempts = 0;
  const api = {
    async getLegacyResumeOperation(input) {
      calls.push(['reconcile', input.operationId, input.nextLiveSessionId]);
      const error = new Error('missing');
      error.status = 404;
      throw error;
    },
    async listSegments({ meetingId }) {
      calls.push(['segments', meetingId]);
      return { segments: [{ id: 'segment-1', status: 'active', sessionId: 'session-1' }] };
    },
    async resumeLegacySegment(input) {
      attempts += 1;
      calls.push(['resume', input.operationId, input.nextLiveSessionId]);
      if (attempts === 1) throw Object.assign(new Error('before commit'), { status: 503 });
      return {
        meeting: { id: input.meetingId },
        segment: { id: 'segment-2', sequence: 2 },
        operation: { payloadHash: input.payloadHash, sourceSegmentId: input.sourceSegmentId },
        effectiveGlossaryRevision: 'revision-b'
      };
    }
  };

  const result = await establishDurableLegacyContinue({
    persistence,
    api,
    meetingId: 'meeting-1',
    sourceSegmentId: 'segment-1',
    expectedSessionId: 'session-1',
    checkpoint,
    cryptoImpl: webcrypto,
    operationIdFactory: () => 'continue-1',
    liveSessionIdFactory: () => 'live-2',
    retryDelaysMs: [0],
    wait: async () => {}
  });

  assert.equal(attempts, 2);
  assert.equal(result.operation.operationId, 'continue-1');
  assert.equal(result.operation.nextLiveSessionId, 'live-2');
  assert.equal(result.result.segment.id, 'segment-2');
  assert.deepEqual(calls.map(([kind]) => kind), [
    'reconcile', 'resume', 'reconcile', 'reconcile', 'segments', 'resume'
  ]);
});

test('reload reconciles committed operation before rejecting changed open Segment', async () => {
  const persistence = createInMemoryLocalMeetingManifestStore();
  await persistence.saveContinueOperation({
    operationId: 'continue-1', meetingId: 'meeting-1', sourceSegmentId: 'segment-1',
    nextLiveSessionId: 'live-2', payloadHash: 'expected-hash', checkpoint, state: 'executing'
  });
  let mutations = 0;
  const api = {
    async getLegacyResumeOperation() {
      return {
        meeting: { id: 'meeting-1' },
        segment: { id: 'segment-2', sequence: 2 },
        operation: { payloadHash: 'expected-hash', sourceSegmentId: 'segment-1' },
        effectiveGlossaryRevision: 'revision-b',
        replayed: true
      };
    },
    async resumeLegacySegment() { mutations += 1; }
  };

  const result = await establishDurableLegacyContinue({
    persistence,
    api,
    meetingId: 'meeting-1',
    sourceSegmentId: 'segment-2',
    checkpoint,
    cryptoImpl: webcrypto,
    operationIdFactory: () => 'must-not-be-used',
    liveSessionIdFactory: () => 'must-not-be-used'
  });

  assert.equal(result.operation.operationId, 'continue-1');
  assert.equal(result.result.segment.id, 'segment-2');
  assert.equal(mutations, 0);
});
