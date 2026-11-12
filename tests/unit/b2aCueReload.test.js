import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applySubtitleCueEvent, createSubtitleCueState, nextCueSequenceFromRecords
} from '../../src/lib/subtitleCues.js';

test('reload allocation floor includes assigned, unassigned and checkpoint Cues', () => {
  const assigned = [{ cue: { cueId: 'cue:s:seg:7', sequence: 7, revision: 3 } }];
  const unassigned = [{ cue: { cueId: 'cue:s:12', segmentId: null, sequence: 12, revision: 4, status: 'final', startTimeMs: 0, endTimeMs: 10, sourceText: 'old', turnKey: 'old-turn' } }];
  const checkpoints = [{ cueId: 'cue:s:seg:9', sequence: 9 }];
  const floor = nextCueSequenceFromRecords(3, assigned, unassigned, checkpoints);
  assert.equal(floor, 13);
  let state = createSubtitleCueState({ nextSequence: floor, finalCues: [unassigned[0].cue] });
  state = applySubtitleCueEvent(state, {
    eventId: 'new-turn', sessionId: 's', segmentId: null,
    turnKey: 'new-turn', stream: 'source', text: 'same', sessionTimeMs: 10000, isFinal: false
  });
  assert.equal(state.currentCue.cueId, 'cue:s:13');
  assert.equal(state.currentCue.segmentId, null);
  assert.equal(state.finalCues[0].cueId, 'cue:s:12');
});

test('unknown-owner Cue allocation requires durable session identity', () => {
  const state = createSubtitleCueState();
  const next = applySubtitleCueEvent(state, {
    eventId: 'unknown-session', segmentId: null, stream: 'source',
    text: 'hello', sessionTimeMs: 10, isFinal: false
  });
  assert.equal(next.currentCue, null);
  assert.equal(next.nextSequence, 1);
});

test('recovered Cue is not revised by reused local speech-turn identity', () => {
  const recovered = {
    cueId: 'cue:s:1', sessionId: 's', segmentId: null, sequence: 1,
    revision: 3, status: 'final', startTimeMs: 100, endTimeMs: 120,
    sourceText: 'hel', translatedText: '', sourceStatus: 'finalized',
    turnKey: 'local:turn-1', sourceVersion: 1, providerEventSequence: 1
  };
  const state = createSubtitleCueState({
    finalCues: [recovered], recoveredCueIds: [recovered.cueId], nextSequence: 2
  });
  const next = applySubtitleCueEvent(state, {
    eventId: 'post-reload', sessionId: 's', segmentId: null,
    turnKey: 'local:turn-1', eventSequence: 2,
    stream: 'source', text: 'hello', sessionTimeMs: 150, isFinal: true
  });
  assert.deepEqual(next.finalCues[0], recovered);
  assert.notEqual(next.currentCue?.cueId, recovered.cueId);
});
