import assert from 'node:assert/strict';
import test from 'node:test';
import { applyMeetingCueEvent, meetingEventGapDetected, mergeMeetingViewerSnapshot } from '../../src/lib/meetingViewerState.js';

const cue = (cueId, segmentSequence, sequence, translatedText = cueId, refinement = 1) => ({
  cueId, segmentSequence, sequence, status: 'final', sourceText: cueId, translatedText,
  refinement: { version: refinement }
});

test('Viewer snapshot and events merge by Cue ID and preserve order', () => {
  let state = mergeMeetingViewerSnapshot(null, { cursor: { eventId: 4, cueSequence: 2 }, cues: [cue('cue-2', 1, 2), cue('cue-1', 1, 1)] });
  state = applyMeetingCueEvent(state, { type: 'cue.append', eventId: 5, cue: cue('cue-2', 1, 2, 'new', 2) });
  state = applyMeetingCueEvent(state, { type: 'cue.append', eventId: 6, cue: cue('cue-3', 2, 1) });

  assert.deepEqual(state.cues.map((item) => item.cueId), ['cue-1', 'cue-2', 'cue-3']);
  assert.equal(state.cues[1].translatedText, 'new');
  assert.deepEqual(state.cursor, { eventId: 6, cueSequence: 2 });
});

test('Viewer detects event gaps from its cursor', () => {
  assert.equal(meetingEventGapDetected({ eventId: 4 }, 6), true);
  assert.equal(meetingEventGapDetected({ eventId: 4 }, 5), false);
  assert.equal(meetingEventGapDetected({ eventId: 0 }, 6), false);
});
