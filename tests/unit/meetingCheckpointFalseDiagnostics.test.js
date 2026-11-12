import assert from 'node:assert/strict';
import test from 'node:test';
import { createMeetingCheckpointSyncCoordinator } from '../../src/lib/meetingCheckpointSyncCoordinator.js';

const scope = { meetingId: 'meeting-1', segmentId: 'segment-1' };
const chunk = (sequence) => ({
  ...scope, idempotencyKey: `chunk-${sequence}`, stream: 'source', sequence, timestamp: 1000,
  text: 'test fixture'
});
const committed = (payload) => ({
  meetingId: payload.meetingId,
  segmentId: payload.segmentId,
  checkpoint: { durableChunks: payload.durableChunks, finalCues: payload.finalCues }
});
const options = (diagnostics, updateCheckpoint) => ({
  updateCheckpoint,
  onDiagnostic: (entry) => diagnostics.push(entry),
  setTimeoutFn: () => 1,
  clearTimeoutFn: () => {}
});

test('diagnoses write exceptions with identity and counts, without fixture content', async () => {
  const diagnostics = [];
  const coordinator = createMeetingCheckpointSyncCoordinator(options(diagnostics, async () => {
    throw Object.assign(new Error('private fixture text'), { code: 'write_failed', status: 503 });
  }));
  coordinator.start(scope);
  coordinator.enqueue([chunk(1)]);
  assert.equal(await coordinator.flush(), false);
  assert.equal(diagnostics[0].reason, 'flush_pending_write_exception');
  assert.deepEqual(diagnostics[0].scope, { ...scope, generation: 1 });
  assert.equal(diagnostics[0].requested.chunks, 1);
  assert.equal(diagnostics[0].errorCode, 'write_failed');
  assert.equal(diagnostics[0].errorStatus, 503);
  assert.doesNotMatch(JSON.stringify(diagnostics), /private fixture text|test fixture/);
});

test('distinguishes a committed checkpoint that does not cover the request', async () => {
  const diagnostics = [];
  const coordinator = createMeetingCheckpointSyncCoordinator(options(diagnostics, async (payload) => ({
    ...committed(payload), checkpoint: { durableChunks: [], finalCues: [] }
  })));
  coordinator.start(scope);
  coordinator.enqueue([chunk(1)]);
  assert.equal(await coordinator.flush(), false);
  assert.equal(diagnostics[0].reason, 'committed_checkpoint_not_covering_flush', JSON.stringify(diagnostics[0]));
  assert.equal(diagnostics[0].committed.committedChunks, 0);
  assert.equal(diagnostics[0].requested.chunks, 1);
});

test('reports the first uncovered Cue condition without content', async () => {
  const diagnostics = [];
  const cue = {
    cueId: 'cue-1', sessionId: 'session-1', segmentId: scope.segmentId,
    sequence: 1, startTimeMs: 0, endTimeMs: 100,
    sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en',
    sourceText: 'private source', translatedText: 'private translation',
    status: 'final', finalizedReason: 'generationComplete'
  };
  const coordinator = createMeetingCheckpointSyncCoordinator(options(diagnostics, async (payload) => ({
    ...committed(payload),
    checkpoint: { durableChunks: [], finalCues: [{ ...cue, finalizedReason: 'final' }] }
  })));
  coordinator.start(scope);
  coordinator.enqueueCues([cue]);
  assert.equal(await coordinator.flush(), false);
  assert.deepEqual(diagnostics[0].committed.cueCoverage,
    { reason: 'cue_field_mismatch', field: 'finalizedReason' });
  assert.doesNotMatch(JSON.stringify(diagnostics), /private source|private translation/);
});

test('distinguishes an expired context', async () => {
  const diagnostics = [];
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const coordinator = createMeetingCheckpointSyncCoordinator(options(diagnostics, async (payload) => {
    entered();
    await waiting;
    return committed(payload);
  }));
  coordinator.start(scope);
  coordinator.enqueue([chunk(1)]);
  const flush = coordinator.flush();
  await started;
  coordinator.start({ ...scope, segmentId: 'segment-2' });
  release();
  assert.equal(await flush, false);
  assert.equal(diagnostics[0].reason, 'context_expired');
  assert.equal(diagnostics[0].activeScope.segmentId, 'segment-2');
});

test('distinguishes pending data after three passes and no context with pending data', async () => {
  const diagnostics = [];
  let writes = 0;
  let coordinator;
  coordinator = createMeetingCheckpointSyncCoordinator(options(diagnostics, async (payload) => {
    writes += 1;
    coordinator.enqueue([chunk(writes + 1)]);
    return committed(payload);
  }));
  coordinator.start(scope);
  coordinator.enqueue([chunk(1)]);
  assert.equal(await coordinator.flush(), false);
  assert.equal(writes, 3);
  assert.equal(diagnostics[0].reason, 'pending_after_max_passes');
  assert.equal(diagnostics[0].pending.chunks, 1);
  coordinator.cancel();
  assert.equal(await coordinator.flush(), false);
  assert.equal(diagnostics[1].reason, 'no_context_with_pending');
});
