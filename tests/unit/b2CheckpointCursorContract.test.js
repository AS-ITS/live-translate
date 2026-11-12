import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto } from 'node:crypto';
import { createLocalMeetingPersistence } from '../../src/lib/localMeetingPersistence.js';
import { createInMemoryLocalMeetingManifestStore } from '../../src/lib/localMeetingStorage.js';

const meetingId = 'b2-checkpoint-contract';
const cue = (segmentId, cueId, sequence) => ({
  cueId, sessionId: 'session-1', segmentId, sequence,
  startTimeMs: sequence * 100, endTimeMs: sequence * 100 + 50,
  sourceLanguageCode: 'en', targetLanguageCode: 'fr',
  sourceText: cueId, translatedText: `translation ${cueId}`,
  status: 'final', finalizedReason: 'turnComplete'
});

test('B2 Checkpoint uses metadata-only storage before and after first Writer ACK', async () => {
  const store = createInMemoryLocalMeetingManifestStore();
  const persistence = createLocalMeetingPersistence({ manifestStore: store, cryptoImpl: webcrypto,
    recordAudio: false, trace: () => {} });
  const segmentId = 'segment-1';
  await persistence.updateCheckpoint({ meetingId, segmentId, idempotencyKey: 'before-ack',
    durableChunks: [], finalCues: [cue(segmentId, 'uncommitted', 1)] });
  assert.deepEqual(await store.listCues(meetingId), []);
  assert.deepEqual((await store.getCheckpoint(meetingId, segmentId)).checkpoint.finalCues, []);

  const committed = await persistence.commitCueMutation({ meetingId, segmentId,
    eventKey: 'writer-ack', side: 'initial', cue: cue(segmentId, 'committed', 1) });
  assert.equal(committed.status, 'committed');
  const cursor = (await store.getCheckpoint(meetingId, segmentId)).checkpoint.cueCursor;
  await persistence.updateCheckpoint({ meetingId, segmentId, idempotencyKey: 'after-ack',
    durableChunks: [], finalCues: [cue(segmentId, 'stale', 2)],
    cueCheckpoint: { finalCues: [cue(segmentId, 'stale', 2)] } });
  const checkpoint = await store.getCheckpoint(meetingId, segmentId);
  assert.deepEqual(checkpoint.checkpoint.finalCues, []);
  assert.equal(checkpoint.checkpoint.cueCheckpoint, null);
  assert.deepEqual(checkpoint.checkpoint.cueCursor, cursor);
  assert.deepEqual((await store.listCues(meetingId)).map((record) => record.cueId), ['committed']);
  await assert.rejects(store.saveCheckpointCursor({ meetingId, segmentId,
    checkpoint: { idempotencyKey: 'direct-forbidden', finalCues: [cue(segmentId, 'stale', 2)] } }),
  (error) => error.code === 'local_checkpoint_cue_content_forbidden');
});

test('B2 Checkpoint cursor remains scoped to its Segment', async () => {
  const store = createInMemoryLocalMeetingManifestStore();
  const persistence = createLocalMeetingPersistence({ manifestStore: store, cryptoImpl: webcrypto,
    recordAudio: false, trace: () => {} });
  for (const [segmentId, cueId] of [['segment-1', 'first'], ['segment-2', 'second']]) {
    await persistence.commitCueMutation({ meetingId, segmentId, eventKey: cueId,
      side: 'initial', cue: cue(segmentId, cueId, 1) });
    await persistence.updateCheckpoint({ meetingId, segmentId, idempotencyKey: `checkpoint-${cueId}`,
      durableChunks: [], finalCues: [cue(segmentId, cueId, 1)] });
  }
  const checkpoints = await store.listCheckpoints(meetingId);
  assert.equal(checkpoints.length, 2);
  assert.deepEqual(checkpoints.map((item) => item.checkpoint.cueCursor.commitCount), [1, 1]);
  assert.ok(checkpoints.every((item) => item.checkpoint.finalCues.length === 0));
  assert.deepEqual((await store.listCues(meetingId)).map((record) => record.cueId), ['first', 'second']);
});
