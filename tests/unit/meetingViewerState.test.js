import assert from 'node:assert/strict';
import test from 'node:test';
import { applyMeetingCueEvent, meetingEventDuplicateDetected, meetingEventGapDetected, mergeMeetingCues, mergeMeetingViewerSnapshot } from '../../src/lib/meetingViewerState.js';

const cue = (cueId, segmentSequence, sequence, translatedText = cueId, refinement = 1) => ({
  cueId, segmentSequence, sequence, status: 'final', sourceText: cueId, translatedText,
  refinement: { version: refinement }
});

test('Viewer snapshot and events merge by Cue ID and preserve order', () => {
  let state = mergeMeetingViewerSnapshot(null, { cursor: { eventId: 4, cueSequence: 2 }, cues: [cue('cue-2', 1, 2), cue('cue-1', 1, 1)] });
  state = applyMeetingCueEvent(state, { type: 'cue.update', eventId: 5, cue: cue('cue-2', 1, 2, 'new', 2) });
  state = applyMeetingCueEvent(state, { type: 'cue.append', eventId: 6, cue: cue('cue-3', 2, 1) });

  assert.deepEqual(state.cues.map((item) => item.cueId), ['cue-1', 'cue-2', 'cue-3']);
  assert.equal(state.cues[1].translatedText, 'new');
  assert.deepEqual(state.cursor, { eventId: 6, cueSequence: 2 });
});

test('Device cue history keeps earlier segments when recording resumes with a new segment', () => {
  const beforePause = [cue('cue-before-pause', 1, 1)];
  const afterResume = [cue('cue-after-resume', 2, 2)];

  const history = mergeMeetingCues(beforePause, afterResume);

  assert.deepEqual(history.map((item) => item.cueId), ['cue-before-pause', 'cue-after-resume']);
});

test('Viewer detects event gaps from its cursor', () => {
  assert.equal(meetingEventGapDetected({ eventId: 4 }, 6), true);
  assert.equal(meetingEventGapDetected({ eventId: 4 }, 5), false);
  assert.equal(meetingEventGapDetected({ eventId: 0 }, 6), false);
});

test('Viewer updates delayed translation in the original source-only Cue', () => {
  const sourceOnly = {
    ...cue('cue-1', 1, 1, ''),
    sourceStatus: 'finalized',
    translationStatus: 'pending',
    sourceVersion: 1,
    translationVersion: 0
  };
  const withTranslation = {
    ...sourceOnly,
    translatedText: 'Hello',
    translationStatus: 'finalized',
    translationVersion: 1
  };
  let state = mergeMeetingViewerSnapshot(null, { cursor: { eventId: 1, cueSequence: 1 }, cues: [sourceOnly] });
  assert.equal(meetingEventDuplicateDetected(state, { cue: withTranslation }), false);
  state = applyMeetingCueEvent(state, { type: 'cue.append', eventId: 2, cue: withTranslation });

  assert.equal(state.cues.length, 1);
  assert.equal(state.cues[0].cueId, 'cue-1');
  assert.equal(state.cues[0].translatedText, 'Hello');
  assert.equal(state.cues[0].translationVersion, 1);
});

test('Viewer preserves translation-first Cue identity when source arrives later', () => {
  const translationOnly = {
    ...cue('cue-1', 1, 1, 'Hello'),
    sourceText: '',
    sourceStatus: 'pending',
    translationStatus: 'finalized',
    sourceVersion: 0,
    translationVersion: 1
  };
  const completed = {
    ...translationOnly,
    sourceText: '你好',
    sourceStatus: 'finalized',
    sourceVersion: 1
  };
  let state = mergeMeetingViewerSnapshot(null, { cursor: { eventId: 1, cueSequence: 1 }, cues: [translationOnly] });
  state = applyMeetingCueEvent(state, { type: 'cue.append', eventId: 2, cue: completed });

  assert.equal(state.cues.length, 1);
  assert.equal(state.cues[0].sourceText, '你好');
  assert.equal(meetingEventDuplicateDetected(state, { cue: translationOnly }), true);
});
