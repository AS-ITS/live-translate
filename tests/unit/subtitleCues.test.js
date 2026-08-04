import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applySubtitleCueEvent,
  createSubtitleCueState,
  finalizePendingSubtitleCue,
  resetSubtitleCueState,
  subtitleCuesForDisplay
} from '../../src/lib/subtitleCues.js';
import { normalizeGeminiLiveCueEvents } from '../../src/lib/geminiLiveCueEvent.js';

test('aggregates source and translation partials into one pending cue', () => {
  let state = createSubtitleCueState();
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'source', text: 'hello wor', sessionTimeMs: 100 }));
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'source', text: 'hello world', sessionTimeMs: 200 }));
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'translation', text: 'bonjour le monde', sessionTimeMs: 240 }));

  assert.deepEqual(state.finalCues, []);
  assert.equal(state.currentCue.sourceText, 'hello world');
  assert.equal(state.currentCue.translatedText, 'bonjour le monde');
  assert.equal(state.currentCue.status, 'partial');
  assert.equal(state.currentCue.sequence, 1);
  assert.equal(state.nextSequence, 1);
});

test('sentence punctuation finalizes a complete cue without creating chunk-sized cues', () => {
  let state = createSubtitleCueState();
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'source', text: 'Hello', sessionTimeMs: 100 }));
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'source', text: 'Hello world.', sessionTimeMs: 200 }));
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'translation', text: 'Bonjour le monde.', sessionTimeMs: 260 }));

  assert.equal(state.currentCue, null);
  assert.deepEqual(state.finalCues.map(({ sourceText, translatedText, status, sequence, finalizedReason }) => ({
    sourceText,
    translatedText,
    status,
    sequence,
    finalizedReason
  })), [
    {
      sourceText: 'Hello world.',
      translatedText: 'Bonjour le monde.',
      status: 'final',
      sequence: 1,
      finalizedReason: 'punctuation'
    }
  ]);
  assert.equal(state.nextSequence, 2);
});

test('turnComplete control event finalizes the pending cue when text is complete enough to submit', () => {
  let state = createSubtitleCueState();
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'source', text: 'source without punctuation', sessionTimeMs: 100 }));
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'translation', text: 'translation without punctuation', sessionTimeMs: 120 }));
  state = applySubtitleCueEvent(state, { turnComplete: true, sessionTimeMs: 500 });

  assert.equal(state.currentCue, null);
  assert.equal(state.finalCues.length, 1);
  assert.equal(state.finalCues[0].finalizedReason, 'turnComplete');
  assert.equal(state.finalCues[0].endTimeMs, 500);
});

test('pause before unrelated new speech finalizes the current cue first', () => {
  let state = createSubtitleCueState();
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'source', text: 'First thought', sessionTimeMs: 100 }));
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'translation', text: 'Premiere idee', sessionTimeMs: 150 }));
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'source', text: 'Second thought', sessionTimeMs: 1200 }), {
    pauseThresholdMs: 900
  });

  assert.deepEqual(state.finalCues.map((cue) => [cue.sourceText, cue.translatedText, cue.finalizedReason]), [
    ['First thought', 'Premiere idee', 'pause']
  ]);
  assert.equal(state.currentCue.sourceText, 'Second thought');
  assert.equal(state.currentCue.translatedText, '');
  assert.equal(state.currentCue.sequence, 2);
});

test('Stop flush finalizes only paired source and translation cue text', () => {
  let incomplete = createSubtitleCueState();
  incomplete = applySubtitleCueEvent(incomplete, baseEvent({ stream: 'source', text: 'source only', sessionTimeMs: 100 }));

  assert.equal(finalizePendingSubtitleCue(incomplete, { sessionTimeMs: 300 }), incomplete);

  let paired = applySubtitleCueEvent(incomplete, baseEvent({ stream: 'translation', text: 'translation now paired', sessionTimeMs: 200 }));
  paired = finalizePendingSubtitleCue(paired, { sessionTimeMs: 300, reason: 'stop' });

  assert.equal(paired.currentCue, null);
  assert.equal(paired.finalCues.length, 1);
  assert.equal(paired.finalCues[0].finalizedReason, 'stop');
});

test('length overflow finalizes the bilingual cue atomically when alignment is uncertain', () => {
  let state = createSubtitleCueState();
  state = applySubtitleCueEvent(state, baseEvent({
    stream: 'source',
    text: 'alpha beta gamma delta',
    sessionTimeMs: 100
  }), { maxCueChars: 12 });
  state = applySubtitleCueEvent(state, baseEvent({
    stream: 'translation',
    text: 'un deux trois quatre',
    sessionTimeMs: 150
  }), { maxCueChars: 12 });

  assert.deepEqual(state.finalCues.map((cue) => [cue.sourceText, cue.translatedText, cue.finalizedReason]), [
    ['alpha beta gamma delta', 'un deux trois quatre', 'length']
  ]);
  assert.equal(state.currentCue, null);
  assert.equal(state.nextSequence, 2);
});

test('sequence stays stable across segment rollover and does not reset timestamps', () => {
  let state = createSubtitleCueState();
  state = applySubtitleCueEvent(state, baseEvent({ segmentId: 'segment-1', stream: 'source', text: '第一句。', sessionTimeMs: 10 }));
  state = applySubtitleCueEvent(state, baseEvent({ segmentId: 'segment-1', stream: 'translation', text: 'First sentence.', sessionTimeMs: 30 }));
  state = applySubtitleCueEvent(state, baseEvent({ segmentId: 'segment-2', stream: 'source', text: '第二句。', sessionTimeMs: 70000 }));
  state = applySubtitleCueEvent(state, baseEvent({ segmentId: 'segment-2', stream: 'translation', text: 'Second sentence.', sessionTimeMs: 70100 }));

  assert.deepEqual(state.finalCues.map((cue) => ({
    cueId: cue.cueId,
    segmentId: cue.segmentId,
    sequence: cue.sequence,
    startTimeMs: cue.startTimeMs
  })), [
    { cueId: 'cue:session-1:segment-1:1', segmentId: 'segment-1', sequence: 1, startTimeMs: 10 },
    { cueId: 'cue:session-1:segment-2:2', segmentId: 'segment-2', sequence: 2, startTimeMs: 70000 }
  ]);
});

test('duplicate transcript events do not append duplicate final cues', () => {
  let state = createSubtitleCueState();
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'source', text: 'Done.', sessionTimeMs: 100 }));
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'translation', text: 'Termine.', sessionTimeMs: 120 }));
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'source', text: 'Done.', sessionTimeMs: 200 }));
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'translation', text: 'Termine.', sessionTimeMs: 220 }));

  assert.equal(state.finalCues.length, 1);
  assert.equal(state.currentCue, null);
});

test('display cues include final cues followed by the current partial cue', () => {
  let state = createSubtitleCueState();
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'source', text: 'Final source.', sessionTimeMs: 100 }));
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'translation', text: 'Final translation.', sessionTimeMs: 120 }));
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'source', text: 'Pending source', sessionTimeMs: 300 }));

  assert.deepEqual(subtitleCuesForDisplay(state).map((cue) => [cue.status, cue.sourceText]), [
    ['final', 'Final source.'],
    ['partial', 'Pending source']
  ]);
});

test('reset clears subtitle cue state', () => {
  assert.deepEqual(resetSubtitleCueState(), createSubtitleCueState());
});

test('replayed eventId is a no-op and survives snapshot restore', () => {
  const event = baseEvent({ eventId: 'provider:event:1', stream: 'source', text: 'hello', sessionTimeMs: 100 });
  const first = applySubtitleCueEvent(createSubtitleCueState(), event);
  const restored = createSubtitleCueState(first);
  const replayed = applySubtitleCueEvent(restored, event);

  assert.equal(replayed, restored);
  assert.deepEqual(replayed.processedEventIds, ['provider:event:1']);
  assert.equal(replayed.currentCue.sourceText, 'hello');
});

test('missing session-relative time is ignored without epoch timestamps', () => {
  const state = createSubtitleCueState();
  assert.equal(applySubtitleCueEvent(state, { ...baseEvent(), text: 'no clock' }), state);
  assert.equal(applySubtitleCueEvent(state, { ...baseEvent(), text: 'no clock', now: Date.now() }), state);
});

test('minimum duration and gap normalize final cue timeline', () => {
  let state = createSubtitleCueState();
  const options = { minimumGapMs: 5, minimumCueDurationMs: 300 };
  state = applySubtitleCueEvent(state, baseEvent({ eventId: 's1', stream: 'source', text: 'one', sessionTimeMs: 100 }), options);
  state = applySubtitleCueEvent(state, baseEvent({ eventId: 't1', stream: 'translation', text: 'uno', sessionTimeMs: 110, isFinal: true }), options);
  state = applySubtitleCueEvent(state, baseEvent({ eventId: 's2', stream: 'source', text: 'two', sessionTimeMs: 111 }), options);
  state = applySubtitleCueEvent(state, baseEvent({ eventId: 't2', stream: 'translation', text: 'dos', sessionTimeMs: 112, isFinal: true }), options);

  assert.deepEqual(state.finalCues.map((cue) => [cue.startTimeMs, cue.endTimeMs]), [
    [100, 400],
    [405, 705]
  ]);
});

test('source-first and translation-first partials share one cue', () => {
  let sourceFirst = createSubtitleCueState();
  sourceFirst = applySubtitleCueEvent(sourceFirst, baseEvent({ eventId: 'a', stream: 'source', text: 'source', sessionTimeMs: 10 }));
  sourceFirst = applySubtitleCueEvent(sourceFirst, baseEvent({ eventId: 'b', stream: 'translation', text: 'translation', sessionTimeMs: 20 }));

  let translationFirst = createSubtitleCueState();
  translationFirst = applySubtitleCueEvent(translationFirst, baseEvent({ eventId: 'c', stream: 'translation', text: 'translation', sessionTimeMs: 10 }));
  translationFirst = applySubtitleCueEvent(translationFirst, baseEvent({ eventId: 'd', stream: 'source', text: 'source', sessionTimeMs: 20 }));

  assert.equal(sourceFirst.currentCue.sequence, 1);
  assert.equal(translationFirst.currentCue.sequence, 1);
  assert.equal(sourceFirst.currentCue.sourceText, translationFirst.currentCue.sourceText);
  assert.equal(sourceFirst.currentCue.translatedText, translationFirst.currentCue.translatedText);
});

test('turnComplete and generationComplete may arrive before their counterpart transcript', () => {
  let state = createSubtitleCueState();
  state = applySubtitleCueEvent(state, baseEvent({ eventId: 'source', stream: 'source', text: 'late source', sessionTimeMs: 10 }));
  state = applySubtitleCueEvent(state, baseEvent({ eventId: 'turn', turnComplete: true, sessionTimeMs: 20 }));
  state = applySubtitleCueEvent(state, baseEvent({ eventId: 'translation', stream: 'translation', text: 'late translation', sessionTimeMs: 30 }));
  assert.equal(state.finalCues.length, 1);
  assert.equal(state.finalCues[0].finalizedReason, 'turnComplete');

  state = createSubtitleCueState();
  state = applySubtitleCueEvent(state, baseEvent({ eventId: 'generation', generationComplete: true, sessionTimeMs: 5 }));
  state = applySubtitleCueEvent(state, baseEvent({ eventId: 'source-2', stream: 'source', text: 'source', sessionTimeMs: 10 }));
  state = applySubtitleCueEvent(state, baseEvent({ eventId: 'translation-2', stream: 'translation', text: 'translation', sessionTimeMs: 12 }));
  assert.equal(state.finalCues.length, 1);
  assert.equal(state.finalCues[0].finalizedReason, 'generationComplete');
});

test('normalizer creates stable stream-specific IDs and control events', () => {
  const message = {
    eventId: 'provider-42',
    serverContent: {
      inputTranscription: { text: 'source' },
      outputTranscription: { text: 'translation' },
      turnComplete: true
    }
  };
  const events = normalizeGeminiLiveCueEvents(message, {
    liveSessionId: 'live-1', sessionId: 'session-1', segmentId: 'segment-1', sessionTimeMs: 123, eventSequence: 7
  });
  assert.equal(events.length, 3);
  assert.equal(new Set(events.map((event) => event.eventId)).size, 3);
  assert.deepEqual(events.map((event) => event.stream), ['source', 'translation', null]);
  assert.equal(events[2].turnComplete, true);
  assert.equal(events[0].sessionTimeMs, 123);
});

function baseEvent(overrides = {}) {
  return {
    sessionId: 'session-1',
    segmentId: 'segment-1',
    sourceLanguageCode: 'zh-Hant',
    targetLanguageCode: 'en',
    isFinal: false,
    ...overrides
  };
}
