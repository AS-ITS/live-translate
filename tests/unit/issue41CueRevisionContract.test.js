import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeFinalCue, validateFinalCue } from '../../src/domain/subtitleCue/index.js';
import { createMeetingCheckpointSyncCoordinator } from '../../src/lib/meetingCheckpointSyncCoordinator.js';
import {
  commitSubtitleCueState, createSubtitleCueState, prepareSubtitleCueStateForNewSegment
} from '../../src/lib/subtitleCues.js';

const scope = { meetingId: 'meeting-1', segmentId: 'segment-1' };
const cue = (changes = {}) => ({
  cueId: 'cue-1', sessionId: 'session-1', segmentId: scope.segmentId,
  sequence: 1, startTimeMs: 0, endTimeMs: 100,
  sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en',
  sourceText: 'source fixture', translatedText: 'translation fixture',
  sourceVersion: 1, translationVersion: 1,
  status: 'final', finalizedReason: 'turnComplete', revision: 1,
  ...changes
});

for (const [name, change] of [
  ['reason-only', { finalizedReason: 'merged' }],
  ['late-final', { sourceVersion: 2, sourceText: 'source fixture extended' }],
  ['refinement', { refinement: { status: 'completed', version: 2 }, refinedTranslation: 'refined fixture' }]
]) {
  test(`accepted ${name} Cue-state change allocates one higher revision`, () => {
    const previous = createSubtitleCueState({ finalCues: [cue()] });
    const proposed = { ...previous, finalCues: [{ ...previous.finalCues[0], ...change }] };
    const next = commitSubtitleCueState(previous, proposed).state;
    assert.equal(next.finalCues[0].revision, 2);
    const repeated = commitSubtitleCueState(next, { ...next, finalCues: [{ ...next.finalCues[0] }] }).state;
    assert.equal(repeated.finalCues[0].revision, 2);
  });
}

test('rollover preparation retains finalized Cue revision', () => {
  const state = createSubtitleCueState({ finalCues: [cue({ revision: 3 })] });
  const prepared = prepareSubtitleCueStateForNewSegment(state, { sessionTimeMs: 200, reason: 'continue' });
  assert.equal(prepared.finalCues[0].revision, 3);
});

test('a reason-only update of the same Cue must persist its newer revision', () => {
  const result = mergeFinalCue([cue()], cue({ revision: 2, finalizedReason: 'merged' }));
  assert.equal(result.updated, true);
  assert.equal(result.cue.finalizedReason, 'merged');
  assert.equal(result.cue.revision, 2);
});

test('an older reason-only Cue revision must not overwrite the newer one', () => {
  const result = mergeFinalCue([cue({ revision: 2, finalizedReason: 'merged' })], cue());
  assert.equal(result.cue.finalizedReason, 'merged');
  assert.equal(result.cue.revision, 2);
});

test('equal Cue revisions with different finalizedReason must conflict', () => {
  assert.throws(
    () => mergeFinalCue([cue()], cue({ finalizedReason: 'merged' })),
    (error) => error.code === 'subtitle_cue_conflict'
  );
});

test('reason-only update with missing revision must not silently retain a different reason', () => {
  const old = cue(); const next = cue({ finalizedReason: 'merged' });
  delete old.revision; delete next.revision;
  assert.throws(
    () => mergeFinalCue([old], next),
    (error) => error.code === 'subtitle_cue_conflict'
  );
});

test('a versioned reason update cannot overwrite legacy Cue without durable proof', () => {
  const old = cue(); delete old.revision;
  assert.throws(
    () => mergeFinalCue([old], cue({ revision: 2, finalizedReason: 'merged' })),
    (error) => error.code === 'subtitle_cue_conflict'
  );
});

test('higher revision cannot regress a finalized side or refinement', () => {
  assert.throws(
    () => mergeFinalCue([cue({ sourceStatus: 'finalized' })],
      cue({ revision: 2, sourceStatus: 'pending' })),
    (error) => error.code === 'subtitle_cue_conflict'
  );
  const completed = cue({
    rawSource: 'source fixture', rawTranslation: 'translation fixture',
    refinement: { status: 'completed', version: 2 }
  });
  const regressed = cue({
    revision: 2, rawSource: 'source fixture', rawTranslation: 'translation fixture',
    refinement: { status: 'pending', version: 1 }
  });
  assert.throws(
    () => mergeFinalCue([completed], regressed),
    (error) => error.code === 'subtitle_cue_conflict'
  );
});

test('Checkpoint Cue normalization must retain supplied revision', () => {
  assert.equal(validateFinalCue(cue({ revision: 2 })).revision, 2);
  const legacy = cue(); delete legacy.revision;
  assert.equal(validateFinalCue(legacy).revision, undefined);
  assert.throws(() => validateFinalCue(cue({ revision: 0 })),
    (error) => error.code === 'subtitle_cue_invalid');
});

test('Coordinator flush must select the newest pending Cue revision first', async () => {
  const writes = [];
  const coordinator = createMeetingCheckpointSyncCoordinator({
    updateCheckpoint: async (payload) => {
      writes.push(payload.finalCues[0]);
      return {
        meetingId: payload.meetingId, segmentId: payload.segmentId,
        checkpoint: { durableChunks: [], finalCues: payload.finalCues }
      };
    },
    onDiagnostic: () => {},
    setTimeoutFn: () => 1, clearTimeoutFn: () => {}
  });
  coordinator.start(scope);
  coordinator.enqueueCues([cue()]);
  coordinator.enqueueCues([cue({ revision: 2, finalizedReason: 'merged' })]);
  await coordinator.flush();
  assert.equal(writes[0].revision, 2);
  assert.equal(writes[0].finalizedReason, 'merged');
});

test('Coordinator must not ACK a versioned Cue from a revisionless Checkpoint', async () => {
  const coordinator = createMeetingCheckpointSyncCoordinator({
    updateCheckpoint: async (payload) => {
      const committed = cue(); delete committed.revision;
      return {
        meetingId: payload.meetingId, segmentId: payload.segmentId,
        checkpoint: { durableChunks: [], finalCues: [committed] }
      };
    },
    onDiagnostic: () => {}, setTimeoutFn: () => 1, clearTimeoutFn: () => {}
  });
  coordinator.start(scope);
  coordinator.enqueueCues([cue({ revision: 2 })]);
  assert.equal(await coordinator.flush(), false);
});

for (const [name, oldCue, newerCue] of [
  ['late-final', cue(), cue({
    revision: 2, sourceVersion: 2, sourceText: 'source fixture extended'
  })],
  ['refinement', cue({
    rawSource: 'source fixture', rawTranslation: 'translation fixture',
    refinement: { status: 'pending', version: 1 }
  }), cue({
    revision: 2, rawSource: 'source fixture', rawTranslation: 'translation fixture',
    refinement: { status: 'completed', version: 2 },
    refinedTranslation: 'refined fixture'
  })]
]) {
  test(`an old Checkpoint must not acknowledge a newer ${name} Cue`, async () => {
    const diagnostics = [];
    const coordinator = createMeetingCheckpointSyncCoordinator({
      updateCheckpoint: async (payload) => ({
        meetingId: payload.meetingId, segmentId: payload.segmentId,
        checkpoint: { durableChunks: [], finalCues: [oldCue] }
      }),
      onDiagnostic: (entry) => diagnostics.push(entry),
      setTimeoutFn: () => 1, clearTimeoutFn: () => {}
    });
    coordinator.start(scope);
    coordinator.enqueueCues([newerCue]);
    assert.equal(await coordinator.flush(), false);
    assert.equal(diagnostics[0].reason, 'committed_checkpoint_not_covering_flush');
  });
}
