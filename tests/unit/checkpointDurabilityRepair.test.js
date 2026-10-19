import assert from 'node:assert/strict';
import test from 'node:test';
import { createInMemoryLocalMeetingManifestStore } from '../../src/lib/localMeetingStorage.js';
import { createMeetingCheckpointSyncCoordinator } from '../../src/lib/meetingCheckpointSyncCoordinator.js';
import { createMeetingCheckpointService } from '../../src/application/meetingCheckpointService.js';
import { createMemoryMeetingRepository } from '../../src/infrastructure/meetingRepositoryAdapter.js';
import { createLegacyContinuePayload } from '../../src/lib/legacyContinueOperation.js';

const cue = (cueId, sequence) => ({
  cueId, sessionId: 'session-1', segmentId: 'segment-1', sequence,
  startTimeMs: sequence * 100, endTimeMs: sequence * 100 + 50,
  sourceLanguageCode: 'en', targetLanguageCode: 'fr',
  status: 'final', sourceText: `source-${sequence}`, translatedText: `translation-${sequence}`,
  finalizedReason: 'turnComplete'
});

function localCoordinator(store) {
  const writes = [];
  const coordinator = createMeetingCheckpointSyncCoordinator({
    updateCheckpoint: async (payload) => {
      writes.push(payload);
      const saved = await store.saveCheckpoint({
        meetingId: payload.meetingId, segmentId: payload.segmentId, checkpoint: payload
      });
      return { meetingId: saved.meetingId, segmentId: saved.segmentId, checkpoint: saved.checkpoint };
    },
    getCheckpoint: ({ meetingId, segmentId }) => store.getCheckpoint(meetingId, segmentId),
    setTimeoutFn: () => 1,
    clearTimeoutFn: () => {}
  });
  coordinator.start({ meetingId: 'meeting-1', segmentId: 'segment-1' });
  return { coordinator, writes };
}

function serviceFixture() {
  const meetingRepository = createMemoryMeetingRepository();
  let nextId = 0;
  const service = createMeetingCheckpointService({
    meetingRepository, idGenerator: (kind) => `${kind}-${++nextId}`, clock: () => 1000
  });
  return { service, meetingRepository };
}

test('two acknowledged cue-only flushes retain both Cues and use distinct keys', async () => {
  const store = createInMemoryLocalMeetingManifestStore();
  const { coordinator, writes } = localCoordinator(store);
  coordinator.enqueueCues([cue('cue-a', 1)]);
  assert.equal(await coordinator.flush(), true);
  coordinator.enqueueCues([cue('cue-b', 2)]);
  assert.equal(await coordinator.flush(), true);
  const stored = await store.getCheckpoint('meeting-1', 'segment-1');
  assert.deepEqual(stored.checkpoint.finalCues.map((item) => item.cueId), ['cue-a', 'cue-b']);
  assert.notEqual(writes[0].idempotencyKey, writes[1].idempotencyKey);
});

test('local checkpoint key is idempotent only for the same canonical payload', async () => {
  const store = createInMemoryLocalMeetingManifestStore();
  const input = { meetingId: 'meeting-1', segmentId: 'segment-1', checkpoint: {
    idempotencyKey: 'same-key', durableChunks: [], finalCues: [cue('cue-a', 1)],
    cueCheckpoint: { nextSequence: 2 }
  } };
  await store.saveCheckpoint(input);
  await store.saveCheckpoint(structuredClone(input));
  await assert.rejects(store.saveCheckpoint({ ...input, checkpoint: {
    ...input.checkpoint, finalCues: [cue('cue-b', 2)]
  } }), (error) => error.code === 'checkpoint_conflict');
  const stored = await store.getCheckpoint('meeting-1', 'segment-1');
  assert.deepEqual(stored.checkpoint.finalCues.map((item) => item.cueId), ['cue-a']);
});

test('service rejects a repeated key with changed cue checkpoint', async () => {
  const { service } = serviceFixture();
  const { meeting, segment } = await service.createMeeting();
  const write = (nextSequence) => service.updateCheckpoint({ meetingId: meeting.id, segmentId: segment.id,
    checkpoint: { idempotencyKey: 'same-key', durableChunks: [], finalCues: [],
      cueCheckpoint: { nextSequence }, pendingPartial: null } });
  await write(1);
  await write(1);
  await assert.rejects(write(2), (error) => error.code === 'checkpoint_conflict');
  const saved = await service.getCheckpoint({ meetingId: meeting.id, segmentId: segment.id });
  assert.equal(saved.checkpoint.cueCheckpoint.nextSequence, 1);
});

test('two overlapping service writers retain both acknowledged chunk deltas', async () => {
  const { service } = serviceFixture();
  const { meeting, segment } = await service.createMeeting();
  const write = (sequence) => service.updateCheckpoint({ meetingId: meeting.id, segmentId: segment.id,
    checkpoint: { idempotencyKey: `operation-${sequence}`, durableChunks: [{
      idempotencyKey: `chunk-${sequence}`, meetingId: meeting.id, segmentId: segment.id,
      stream: 'source', sequence, text: `text-${sequence}`, timestamp: 1000 + sequence
    }], finalCues: [], pendingPartial: null } });
  const results = await Promise.allSettled([write(1), write(2)]);
  assert.deepEqual(results.map((result) => result.status), ['fulfilled', 'fulfilled']);
  const saved = await service.getCheckpoint({ meetingId: meeting.id, segmentId: segment.id });
  assert.deepEqual(saved.checkpoint.durableChunks.map((item) => item.sequence), [1, 2]);
});

test('older cue engine snapshot cannot replace a newer committed snapshot', async () => {
  const store = createInMemoryLocalMeetingManifestStore();
  const write = (key, nextSequence) => store.saveCheckpoint({
    meetingId: 'meeting-1', segmentId: 'segment-1', checkpoint: {
      idempotencyKey: key, durableChunks: [], finalCues: [], cueCheckpoint: { nextSequence }
    }
  });
  await write('newer', 3);
  await assert.rejects(write('older', 2), (error) => error.code === 'checkpoint_conflict');
  const saved = await store.getCheckpoint('meeting-1', 'segment-1');
  assert.equal(saved.checkpoint.cueCheckpoint.nextSequence, 3);
});

test('checkpoint ownership remains separate across meetings and segments', async () => {
  const store = createInMemoryLocalMeetingManifestStore();
  for (const [meetingId, segmentId, cueId] of [
    ['meeting-a', 'segment-a', 'cue-a'], ['meeting-a', 'segment-b', 'cue-b'],
    ['meeting-b', 'segment-a', 'cue-c']
  ]) {
    await store.saveCheckpoint({ meetingId, segmentId, checkpoint: {
      idempotencyKey: 'same-key', durableChunks: [],
      finalCues: [{ ...cue(cueId, 1), segmentId }]
    } });
  }
  const read = async (meetingId, segmentId) =>
    (await store.getCheckpoint(meetingId, segmentId)).checkpoint.finalCues[0].cueId;
  assert.equal(await read('meeting-a', 'segment-a'), 'cue-a');
  assert.equal(await read('meeting-a', 'segment-b'), 'cue-b');
  assert.equal(await read('meeting-b', 'segment-a'), 'cue-c');
});

test('legacy Continue payload reads the complete acknowledged checkpoint after reload', async () => {
  const store = createInMemoryLocalMeetingManifestStore();
  const { coordinator } = localCoordinator(store);
  coordinator.enqueueCues([cue('cue-a', 1)]);
  assert.equal(await coordinator.flush(), true);
  coordinator.enqueueCues([cue('cue-b', 2)]);
  assert.equal(await coordinator.flush(), true);
  const reloaded = await store.getCheckpoint('meeting-1', 'segment-1');
  const payload = createLegacyContinuePayload({
    meetingId: 'meeting-1', sourceSegmentId: 'segment-1',
    nextLiveSessionId: 'live-2', expectedSessionId: 'session-1', checkpoint: reloaded.checkpoint
  });
  assert.deepEqual(payload.checkpoint.finalCues.map((item) => item.cueId), ['cue-a', 'cue-b']);
});

test('canonical replay accepts Cue array order changes without a second revision', async () => {
  const store = createInMemoryLocalMeetingManifestStore();
  const checkpoint = { idempotencyKey: 'same-key', durableChunks: [],
    finalCues: [cue('cue-a', 1), cue('cue-b', 2)] };
  const first = await store.saveCheckpoint({ meetingId: 'meeting-1', segmentId: 'segment-1', checkpoint });
  const second = await store.saveCheckpoint({ meetingId: 'meeting-1', segmentId: 'segment-1',
    checkpoint: { ...checkpoint, finalCues: [...checkpoint.finalCues].reverse() } });
  assert.equal(first.checkpoint.revision, 1);
  assert.equal(second.checkpoint.revision, 1);
});

test('same Cue ID in another Session conflicts without changing acknowledged owner', async () => {
  const store = createInMemoryLocalMeetingManifestStore();
  await store.saveCheckpoint({ meetingId: 'meeting-1', segmentId: 'segment-1', checkpoint: {
    idempotencyKey: 'first', durableChunks: [], finalCues: [cue('cue-a', 1)]
  } });
  await assert.rejects(store.saveCheckpoint({ meetingId: 'meeting-1', segmentId: 'segment-1', checkpoint: {
    idempotencyKey: 'second', durableChunks: [],
    finalCues: [{ ...cue('cue-a', 1), sessionId: 'session-2' }]
  } }), (error) => error.code === 'subtitle_cue_conflict' || error.code === 'checkpoint_conflict');
  const saved = await store.getCheckpoint('meeting-1', 'segment-1');
  assert.equal(saved.checkpoint.finalCues[0].sessionId, 'session-1');
});
