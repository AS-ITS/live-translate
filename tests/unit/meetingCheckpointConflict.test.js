import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeCheckpoint } from '../../src/application/meetingCheckpointService.js';
import { createMeetingCheckpointSyncCoordinator } from '../../src/lib/meetingCheckpointSyncCoordinator.js';

test('checkpoint merge keeps the most complete text for the same chunk sequence', () => {
  const result = mergeCheckpoint({
    meetingId: 'meeting-1',
    segmentId: 'segment-1',
    existing: checkpoint({
      durableChunks: [chunk({ text: '你', timestamp: 100 })]
    }),
    incoming: checkpoint({
      idempotencyKey: 'checkpoint-2',
      durableChunks: [chunk({ idempotencyKey: 'chunk-source-1-revised', text: '你好。', timestamp: 120 })]
    }),
    updatedAt: 120
  });

  assert.deepEqual(result.durableChunks.map(({ text }) => text), ['你好。']);
});

test('checkpoint merge still rejects unrelated text conflicts', () => {
  assert.throws(
    () => mergeCheckpoint({
      meetingId: 'meeting-1',
      segmentId: 'segment-1',
      existing: checkpoint({ durableChunks: [chunk({ text: '你好' })] }),
      incoming: checkpoint({
        durableChunks: [chunk({ idempotencyKey: 'chunk-source-1-revised', text: '完全不同' })]
      }),
      updatedAt: 120
    }),
    (error) => error.code === 'checkpoint_conflict'
  );
});

test('checkpoint coordinator retains a pending chunk when conflict reconciliation sees different text', async () => {
  const calls = [];
  let shouldConflict = true;
  const coordinator = createMeetingCheckpointSyncCoordinator({
    updateCheckpoint: async (payload) => {
      calls.push(payload);
      if (shouldConflict) {
        shouldConflict = false;
        const error = new Error('checkpoint conflict');
        error.status = 409;
        throw error;
      }
      return {
        meetingId: payload.meetingId,
        segmentId: payload.segmentId,
        checkpoint: { durableChunks: payload.durableChunks, finalCues: payload.finalCues }
      };
    },
    getCheckpoint: async () => ({ checkpoint: { durableChunks: [chunk({ text: '你' })], finalCues: [] } }),
    setTimeoutFn: () => {},
    clearTimeoutFn: () => {}
  });

  coordinator.start({ meetingId: 'meeting-1', segmentId: 'segment-1' });
  coordinator.enqueue([chunk({ text: '你好。' })]);

  assert.equal(await coordinator.flush(), false);
  assert.equal(await coordinator.flush(), true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].durableChunks[0].text, '你好。');
});

function checkpoint(overrides = {}) {
  return {
    idempotencyKey: overrides.idempotencyKey ?? 'checkpoint-1',
    durableChunks: overrides.durableChunks ?? [],
    finalCues: overrides.finalCues ?? [],
    refinedSubtitleCues: [],
    refinedSubtitleRevision: 0,
    refinedSubtitleInputHash: null,
    refinedSubtitleStatus: 'pending',
    cueCheckpoint: null
  };
}

function chunk(overrides = {}) {
  const stream = overrides.stream ?? 'source';
  const sequence = overrides.sequence ?? 1;
  return {
    idempotencyKey: overrides.idempotencyKey ?? `chunk-${stream}-${sequence}`,
    meetingId: overrides.meetingId ?? 'meeting-1',
    segmentId: overrides.segmentId ?? 'segment-1',
    stream,
    sequence,
    text: overrides.text ?? 'text',
    timestamp: overrides.timestamp ?? 1000
  };
}
