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

test('a stale reconnect snapshot cannot overwrite a newer live Cue', () => {
  const newest = { ...cue('cue-1', 1, 1, 'newest', 3), sourceVersion: 2, translationVersion: 3 };
  const stale = { ...cue('cue-1', 1, 1, 'stale', 1), sourceVersion: 1, translationVersion: 1 };
  const current = mergeMeetingViewerSnapshot(null, { cursor: { eventId: 10, cueSequence: 1 }, cues: [newest] });
  const merged = mergeMeetingViewerSnapshot(current, { cursor: { eventId: 5, cueSequence: 1 }, cues: [stale] });

  assert.equal(merged.cues[0].translatedText, 'newest');
  assert.deepEqual(merged.cursor, { eventId: 10, cueSequence: 1 });
});

test('live Cue without segmentSequence stays after earlier persisted segments', () => {
  const previous = [cue('old-1', 1, 1), cue('old-2', 1, 2)];
  const live = { cueId: 'new-1', segmentId: 'segment-2', sequence: 1, sourceText: 'latest', status: 'final' };
  const merged = mergeMeetingCues(previous, [live]);
  assert.deepEqual(merged.map((item) => item.cueId), ['old-1', 'old-2', 'new-1']);
});

test('ordered new Segment stays after earlier Cues whose Segment order is unavailable', () => {
  const previous = [
    { cueId: 'old-1', segmentId: 'segment-1', sequence: 1 },
    { cueId: 'old-2', segmentId: 'segment-1', sequence: 2 }
  ];
  const live = { ...cue('new-1', 2, 1), segmentId: 'segment-2' };

  const merged = mergeMeetingCues(previous, [live]);

  assert.deepEqual(merged.map((item) => item.cueId), ['old-1', 'old-2', 'new-1']);
});

test('later partial update keeps a Cue order key and independently newer text', () => {
  const original = { ...cue('cue-1', 2, 1, ''), segmentId: 'segment-2', sourceVersion: 2, translationVersion: 0 };
  const translation = { cueId: 'cue-1', segmentId: 'segment-2', sequence: 1, sourceVersion: 1,
    translationVersion: 1, translatedText: 'late translation', status: 'final' };
  const state = mergeMeetingCues([cue('old', 1, 1), original], [translation]);
  assert.deepEqual(state.map((item) => item.cueId), ['old', 'cue-1']);
  assert.equal(state[1].sourceText, 'cue-1');
  assert.equal(state[1].translatedText, 'late translation');
  assert.equal(state[1].segmentSequence, 2);
});
test('Viewer snapshot update and replay keep canonical raw source', () => {
  const initial = {
    ...cue('cue-raw', 1, 1, 'translation'),
    sourceText: 'refined source',
    rawSource: 'raw source',
    refinedSource: 'refined source',
    sourceVersion: 1
  };
  let state = mergeMeetingViewerSnapshot(null, { cursor: { eventId: 1, cueSequence: 1 }, cues: [initial] });
  assert.equal(state.cues[0].sourceText, 'raw source');

  const update = {
    ...initial,
    sourceText: 'new refined source',
    rawSource: 'raw source updated',
    refinedSource: 'new refined source',
    sourceVersion: 2
  };
  state = applyMeetingCueEvent(state, { type: 'cue.update', eventId: 2, cue: update });
  state = applyMeetingCueEvent(state, { type: 'cue.update', eventId: 2, cue: update });

  assert.equal(state.cues[0].sourceText, 'raw source updated');
  assert.equal(state.cues[0].refinedSource, 'new refined source');
});
