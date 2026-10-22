import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto } from 'node:crypto';
import { createMeetingCheckpointSyncCoordinator } from '../../src/lib/meetingCheckpointSyncCoordinator.js';
import { createLocalMeetingPersistence } from '../../src/lib/localMeetingPersistence.js';
import { createInMemoryLocalMeetingManifestStore } from '../../src/lib/localMeetingStorage.js';

const meetingId = 'cross-segment-meeting';
const sessionId = 'cross-segment-session';

function cue(cueId, segmentId, sequence) {
  return {
    cueId, sessionId, segmentId, sequence,
    startTimeMs: sequence * 100, endTimeMs: sequence * 100 + 50,
    sourceLanguageCode: 'en', targetLanguageCode: 'fr',
    sourceText: `source ${sequence}`, translatedText: `translation ${sequence}`,
    status: 'final', finalizedReason: 'turnComplete'
  };
}

function fixture() {
  const persistence = createLocalMeetingPersistence({
    manifestStore: createInMemoryLocalMeetingManifestStore(),
    cryptoImpl: webcrypto,
    recordAudio: false,
    trace: () => {}
  });
  const calls = [];
  const coordinator = createMeetingCheckpointSyncCoordinator({
    updateCheckpoint: async (payload) => {
      calls.push(payload);
      return persistence.updateCheckpoint(payload);
    },
    getCheckpoint: (scope) => persistence.getCheckpoint(scope),
    setTimeoutFn: () => 1,
    clearTimeoutFn: () => {}
  });
  return { persistence, calls, coordinator };
}

test('mixed old and current Cues keep their identity and persist under their own segments', async () => {
  const { persistence, calls, coordinator } = fixture();
  const oldCue = cue('cue-2', 'segment-2', 2);
  const currentCue = cue('cue-3', 'segment-3', 3);
  await persistence.saveCue({ meetingId, segmentId: oldCue.segmentId, sessionId, cue: oldCue });
  coordinator.start({ meetingId, segmentId: 'segment-3' });
  // App saves late Cues independently before offering them to the Checkpoint coordinator.
  await persistence.saveCue({ meetingId, segmentId: oldCue.segmentId, sessionId, cue: oldCue });
  await persistence.saveCue({ meetingId, segmentId: currentCue.segmentId, sessionId, cue: currentCue });
  coordinator.enqueueCues([oldCue, currentCue], { nextSequence: 4 });

  assert.equal(await coordinator.flush(), true);
  assert.deepEqual(calls[0].finalCues.map(({ cueId, segmentId }) => ({ cueId, segmentId })), [
    { cueId: 'cue-3', segmentId: 'segment-3' }
  ]);
  assert.equal(oldCue.segmentId, 'segment-2');
  assert.deepEqual((await persistence.listCues(meetingId, { segmentId: 'segment-2' })).map(({ cue }) => cue.cueId), ['cue-2']);
  assert.deepEqual((await persistence.listCues(meetingId, { segmentId: 'segment-3' })).map(({ cue }) => cue.cueId), ['cue-3']);
  assert.deepEqual((await persistence.getCheckpoint({ meetingId, segmentId: 'segment-3' })).checkpoint.finalCues.map(({ cueId }) => cueId), ['cue-3']);
});

test('missing or invalid segment identity is never attributed to the active Checkpoint', async () => {
  const { persistence, calls, coordinator } = fixture();
  coordinator.start({ meetingId, segmentId: 'segment-3' });
  coordinator.enqueueCues([
    cue('missing-segment', undefined, 1),
    cue('invalid-segment', '', 2),
    cue('current', 'segment-3', 3)
  ], { nextSequence: 4 });

  assert.equal(await coordinator.flush(), true);
  assert.deepEqual(calls[0].finalCues.map(({ cueId }) => cueId), ['current']);
  assert.deepEqual((await persistence.getCheckpoint({ meetingId, segmentId: 'segment-3' })).checkpoint.finalCues.map(({ cueId }) => cueId), ['current']);
});
