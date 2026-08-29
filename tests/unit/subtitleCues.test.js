import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applySubtitleCueEvent,
  createSubtitleCueState,
  dismissSubtitleCue,
  MAX_PROCESSED_EVENT_IDS,
  finalizePendingSubtitleCue,
  prepareSubtitleCueStateForNewSegment,
  resolveIdleSubtitleCue,
  resetSubtitleCueState,
  subtitleCuesForDisplay
} from '../../src/lib/subtitleCues.js';
import { missingNumericIntegrity } from '../../src/lib/numericIntegrity.js';
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
  assert.equal(state.nextSequence, 2);
});

test('polishing data cannot mutate canonical Cue source or translation', () => {
  const state = {
    ...createSubtitleCueState(),
    finalCues: [{
      cueId: 'cue-1', sequence: 1, status: 'final', sourceText: '常會議',
      translatedText: 'The regular meeting.'
    }]
  };

  assert.equal(state.finalCues[0].sourceText, '常會議');
  assert.equal(state.finalCues[0].translatedText, 'The regular meeting.');
});

test('keeps fragmented words and CJK fragments in one pending pair', () => {
  let state = createSubtitleCueState();
  for (const event of [
    baseEvent({ stream: 'source', text: '因為我6', sessionTimeMs: 100, isFinal: true }),
    baseEvent({ stream: 'source', text: '點多才會回來。', sessionTimeMs: 120, isFinal: true }),
    baseEvent({ stream: 'translation', text: 'because I will return.', sessionTimeMs: 140, isFinal: true })
  ]) state = applySubtitleCueEvent(state, event);
  assert.equal(state.finalCues.length, 0);
  assert.equal(state.currentCue.sourceText, '因為我6點多才會回來。');

  state = createSubtitleCueState();
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'source', text: 'tomo', sessionTimeMs: 100 }));
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'source', text: 'rrow', sessionTimeMs: 110 }));
  assert.equal(state.currentCue.sourceText, 'tomorrow');
});

test('does not finalize or slice a paired cue at max length without a safe boundary', () => {
  let state = createSubtitleCueState();
  const options = { maxCueChars: 5 };
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'source', text: 'one two three four', sessionTimeMs: 100, isFinal: true }), options);
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'translation', text: '一二三四五六', sessionTimeMs: 110, isFinal: true }), options);
  assert.equal(state.finalCues.length, 0);
  assert.equal(state.currentCue.sourceText, 'one two three four');
  state = finalizePendingSubtitleCue(state, { ...options, sessionTimeMs: 200, reason: 'stop' });
  assert.equal(state.finalCues[0].sourceText, 'one two three four');
});

test('sentence punctuation stays pending until an explicit flush', () => {
  let state = createSubtitleCueState();
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'source', text: 'Hello', sessionTimeMs: 100 }));
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'source', text: 'Hello world.', sessionTimeMs: 200 }));
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'translation', text: 'Bonjour le monde.', sessionTimeMs: 260 }));

  assert.equal(state.finalCues.length, 0);
  state = finalizePendingSubtitleCue(state, { sessionTimeMs: 300, reason: 'turnComplete' });
  assert.equal(state.finalCues.length, 1);
  assert.equal(state.currentCue, null);

  assert.deepEqual(state.finalCues.map(({ sourceText, translatedText, finalizedReason }) => ({
    sourceText, translatedText, finalizedReason
  })), [{
    sourceText: 'Hello world.',
    translatedText: 'Bonjour le monde.',
    finalizedReason: 'turnComplete'
  }]);
});

test('preparing a new Segment finalizes paired recovery Cues and clears partial metadata', () => {
  let state = createSubtitleCueState({
    finalCues: [{
      cueId: 'cue:old:segment:1', sessionId: 'session-1', segmentId: 'segment-old', sequence: 1,
      startTimeMs: 10, endTimeMs: 100, sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en',
      sourceText: '上一句', translatedText: 'the previous sentence', status: 'final', finalizedReason: 'final'
    }],
    nextSequence: 2,
    processedEventIds: ['old-event'],
    pendingBoundary: { turnComplete: true, generationComplete: false },
    currentCue: {
      cueId: 'cue:old:segment:2', sessionId: 'session-1', liveSessionId: 'live-old', segmentId: 'segment-old',
      sequence: 2, startTimeMs: 200, endTimeMs: 240, sourceText: '續錄前最後一句',
      translatedText: 'the last sentence before resume', status: 'partial', updatedTimeMs: 240
    }
  });

  state = prepareSubtitleCueStateForNewSegment(state, { sessionTimeMs: 300, reason: 'resume' });

  assert.equal(state.finalCues.length, 2);
  assert.equal(state.finalCues[1].sourceText, '續錄前最後一句');
  assert.equal(state.nextSequence, 3);
  assert.equal(state.currentCue, null);
  assert.deepEqual(state.pendingCues, []);
  assert.deepEqual(state.pendingBoundary, { turnComplete: false, generationComplete: false });
  assert.deepEqual(state.processedEventIds, []);
  assert.equal(state.lastFinalizedCueId, null);
});

test('preparing a new Segment drops an unmatched source-only recovery Cue', () => {
  const state = prepareSubtitleCueStateForNewSegment(createSubtitleCueState({
    nextSequence: 4,
    currentCue: {
      cueId: 'cue:old:segment:4', sessionId: 'session-1', liveSessionId: 'live-old', segmentId: 'segment-old',
      sequence: 4, startTimeMs: 200, endTimeMs: 220, sourceText: '沒有翻譯', translatedText: '', status: 'partial', updatedTimeMs: 220
    }
  }), { sessionTimeMs: 300, reason: 'resume' });

  assert.deepEqual(state.finalCues, []);
  assert.equal(state.nextSequence, 4);
  assert.equal(state.currentCue, null);
  assert.deepEqual(state.pendingCues, []);
});

test('source-only retranslation has bounded retries and a stable failure state', () => {
  let state = createSubtitleCueState({ currentCue: {
    cueId: 'cue:source-only', sessionId: 'session-1', segmentId: 'segment-1', sequence: 1,
    startTimeMs: 10, endTimeMs: 20, sourceText: 'source only', translatedText: '', status: 'partial', updatedTimeMs: 20
  } });
  let result = resolveIdleSubtitleCue(state, { cueId: 'cue:source-only', sessionTimeMs: 100, maxRetranslationAttempts: 2 });
  assert.equal(result.action, 'needs-retranslation');
  state = result.state;
  result = resolveIdleSubtitleCue(state, { cueId: 'cue:source-only', updatedTimeMs: 100, sessionTimeMs: 200, maxRetranslationAttempts: 2 });
  assert.equal(result.action, 'needs-retranslation');
  state = result.state;
  result = resolveIdleSubtitleCue(state, { cueId: 'cue:source-only', updatedTimeMs: 200, sessionTimeMs: 300, maxRetranslationAttempts: 2 });
  assert.equal(result.action, 'translation-failed');
  assert.equal(result.state.currentCue.translationStatus, 'failed');
  assert.equal(resolveIdleSubtitleCue(result.state, { cueId: 'cue:source-only', updatedTimeMs: 300, sessionTimeMs: 400 }).state, result.state);
});

test('buffers short Chinese fragments until a complete paired sentence is available', () => {
  let state = createSubtitleCueState();
  state = applySubtitleCueEvent(state, baseEvent({ eventId: 'source-1', stream: 'source', text: '資料，今天才', sessionTimeMs: 100 }));
  state = applySubtitleCueEvent(state, baseEvent({ eventId: 'translation-1', stream: 'translation', text: 'Data, only today', sessionTimeMs: 110 }));
  assert.equal(state.finalCues.length, 0);

  state = applySubtitleCueEvent(state, baseEvent({ eventId: 'source-2', stream: 'source', text: '有資料才給他的。', sessionTimeMs: 200 }));
  state = applySubtitleCueEvent(state, baseEvent({ eventId: 'translation-2', stream: 'translation', text: 'will be given to him.', sessionTimeMs: 210 }));
  state = finalizePendingSubtitleCue(state, { sessionTimeMs: 300, reason: 'turnComplete' });

  assert.deepEqual(state.finalCues.map(({ sourceText, translatedText }) => ({ sourceText, translatedText })), [{
    sourceText: '資料，今天才有資料才給他的。',
    translatedText: 'Data, only today will be given to him.'
  }]);
});

test('turnComplete uses debounce and finalizes a short Chinese fragment after idle', () => {
  let state = createSubtitleCueState();
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'source', text: '資料，今天才', sessionTimeMs: 100 }));
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'translation', text: 'Data, only today', sessionTimeMs: 110 }));
  state = applySubtitleCueEvent(state, { eventId: 'boundary', turnComplete: true, sessionTimeMs: 200 });
  const candidate = state.currentCue || state.pendingCues[0];

  assert.equal(resolveIdleSubtitleCue(state, {
    cueId: candidate.cueId,
    updatedTimeMs: candidate.updatedTimeMs,
    sessionTimeMs: 899
  }).action, 'waiting-for-more-text');
  assert.equal(resolveIdleSubtitleCue(state, {
    cueId: candidate.cueId,
    updatedTimeMs: candidate.updatedTimeMs,
    sessionTimeMs: 900
  }).action, 'finalized');

  let completeState = createSubtitleCueState();
  completeState = applySubtitleCueEvent(completeState, baseEvent({ stream: 'source', text: 'this is complete', sessionTimeMs: 100 }));
  completeState = applySubtitleCueEvent(completeState, baseEvent({ stream: 'translation', text: '這是一個完整句子', sessionTimeMs: 110 }));
  completeState = applySubtitleCueEvent(completeState, { eventId: 'complete-boundary', turnComplete: true, sessionTimeMs: 200 });
  const completeCandidate = completeState.currentCue || completeState.pendingCues[0];
  assert.equal(resolveIdleSubtitleCue(completeState, {
    cueId: completeCandidate.cueId,
    updatedTimeMs: completeCandidate.updatedTimeMs,
    sessionTimeMs: 899
  }).action, 'waiting-for-more-text');
  assert.equal(resolveIdleSubtitleCue(completeState, {
    cueId: completeCandidate.cueId,
    updatedTimeMs: completeCandidate.updatedTimeMs,
    sessionTimeMs: 900
  }).action, 'finalized');
});

test('merges short fragments across turnComplete boundaries until punctuation', () => {
  let state = createSubtitleCueState();
  const appendTurn = (sourceText, translatedText, time) => {
    state = applySubtitleCueEvent(state, baseEvent({ stream: 'source', text: sourceText, sessionTimeMs: time, isFinal: true }));
    state = applySubtitleCueEvent(state, baseEvent({ stream: 'translation', text: translatedText, sessionTimeMs: time + 10, isFinal: true }));
    state = applySubtitleCueEvent(state, { eventId: `boundary-${time}`, turnComplete: true, sessionTimeMs: time + 20 });
    state = finalizePendingSubtitleCue(state, { sessionTimeMs: time + 700, reason: 'turnComplete' });
  };

  appendTurn('First,', 'First,', 100);
  appendTurn('two, three, four.', 'two, three, four.', 500);

  assert.deepEqual(state.finalCues.map(({ sourceText, translatedText }) => ({ sourceText, translatedText })), [
    { sourceText: 'First, two, three, four.', translatedText: 'First, two, three, four.' }
  ]);
});

test('numeric integrity detects a dropped minute without rejecting punctuation formatting', () => {
  assert.deepEqual(missingNumericIntegrity('現在是下午4點50分。', "Right now it's 4:00 PM."), {
    expectedDigits: '450',
    actualDigits: '400'
  });
  assert.equal(missingNumericIntegrity('現在是下午4點50分。', "Right now it's 4:50 PM."), null);
  assert.equal(missingNumericIntegrity('序號1234。', 'Number 1,234.'), null);
});

test('numeric correction output replaces the targeted final translation Cue', () => {
  let state = createSubtitleCueState();
  state = applySubtitleCueEvent(state, baseEvent({ eventId: 'source', stream: 'source', text: '現在是下午4點50分。', sessionTimeMs: 100, isFinal: true }));
  state = applySubtitleCueEvent(state, baseEvent({ eventId: 'translation', stream: 'translation', text: "Right now it's 4:00 PM.", sessionTimeMs: 110, isFinal: true }));
  state = finalizePendingSubtitleCue(state, { sessionTimeMs: 200, reason: 'turnComplete' });
  const cueId = state.finalCues[0].cueId;

  state = applySubtitleCueEvent(state, baseEvent({
    eventId: 'correction',
    stream: 'translation',
    text: "Right now it's 4:50 PM.",
    sessionTimeMs: 300,
    isFinal: true,
    retranslationCueId: cueId
  }));

  assert.equal(state.finalCues.length, 1);
  assert.equal(state.finalCues[0].translatedText, "Right now it's 4:50 PM.");
  assert.equal(state.finalCues[0].finalizedReason, 'numeric-correction');
});

test('late final source transcript extends the same finalized Cue', () => {
  let state = createSubtitleCueState();
  state = applySubtitleCueEvent(state, baseEvent({
    eventId: 'source-short', stream: 'source', text: '現在下午時間4', sessionTimeMs: 100, isFinal: true
  }));
  state = applySubtitleCueEvent(state, baseEvent({
    eventId: 'translation-short', stream: 'translation', text: 'The time is now', sessionTimeMs: 110, isFinal: true
  }));
  state = finalizePendingSubtitleCue(state, { sessionTimeMs: 200, reason: 'turnComplete' });

  state = applySubtitleCueEvent(state, baseEvent({
    eventId: 'source-late',
    stream: 'source',
    text: '現在下午時間4點30分',
    sessionTimeMs: 300,
    isFinal: true,
    isLateTranscript: true
  }));

  assert.equal(state.finalCues.length, 1);
  assert.equal(state.finalCues[0].sourceText, '現在下午時間4點30分');
  assert.equal(state.finalCues[0].translatedText, 'The time is now');
});

test('late events revise the last debounced cue without changing its identity', () => {
  let state = createSubtitleCueState();
  state = applySubtitleCueEvent(state, baseEvent({ eventId: 'source-1', stream: 'source', text: '資料，今天才這個資料內容目前', sessionTimeMs: 100 }));
  state = applySubtitleCueEvent(state, baseEvent({ eventId: 'translation-1', stream: 'translation', text: 'Data, only today so far', sessionTimeMs: 110 }));
  state = applySubtitleCueEvent(state, { eventId: 'boundary', turnComplete: true, sessionTimeMs: 200 });
  const candidate = state.currentCue || state.pendingCues[0];
  state = resolveIdleSubtitleCue(state, {
    cueId: candidate.cueId,
    updatedTimeMs: candidate.updatedTimeMs,
    sessionTimeMs: 900
  }).state;
  const cueId = state.finalCues[0].cueId;

  state = applySubtitleCueEvent(state, baseEvent({ eventId: 'source-2', stream: 'source', text: '有資料才給他的。', sessionTimeMs: 1000 }));
  state = applySubtitleCueEvent(state, baseEvent({ eventId: 'translation-2', stream: 'translation', text: 'will be given to him.', sessionTimeMs: 1010 }));

  assert.equal(state.finalCues[0].cueId, cueId);
  assert.equal(state.finalCues[0].finalizedReason, 'merged');
  assert.equal(state.finalCues[0].sourceText, '資料，今天才這個資料內容目前有資料才給他的。');
  assert.equal(state.currentCue, null);
});

test('merges adjacent short bilingual cues until sentence punctuation', () => {
  let state = createSubtitleCueState();
  const appendFinalPair = (sourceText, translatedText, time) => {
    state = applySubtitleCueEvent(state, baseEvent({ stream: 'source', text: sourceText, sessionTimeMs: time, isFinal: true }));
    state = applySubtitleCueEvent(state, baseEvent({ stream: 'translation', text: translatedText, sessionTimeMs: time + 10, isFinal: true }));
    state = finalizePendingSubtitleCue(state, { sessionTimeMs: time + 20, reason: 'test' });
  };

  appendFinalPair('Actually,', '其實，', 100);
  appendFinalPair("it's very", '很', 200);
  appendFinalPair('Right now,', '現在，', 300);

  assert.equal(state.finalCues.length, 1);
  assert.deepEqual(state.finalCues[0], {
    ...state.finalCues[0],
    sourceText: "Actually, it's very Right now,",
    translatedText: '其實，很現在，',
    finalizedReason: 'merged'
  });
  assert.equal(state.finalCues[0].sequence, 1);
  assert.equal(state.finalCues[0].startTimeMs, 100);
  assert.equal(state.finalCues[0].endTimeMs, 400);
  assert.equal(state.nextSequence, 3);
});

test('does not merge after sentence punctuation', () => {
  let state = createSubtitleCueState();
  const appendFinalPair = (sourceText, translatedText, time, options = {}) => {
    state = applySubtitleCueEvent(state, baseEvent({ stream: 'source', text: sourceText, sessionTimeMs: time, isFinal: true }), options);
    state = applySubtitleCueEvent(state, baseEvent({ stream: 'translation', text: translatedText, sessionTimeMs: time + 10, isFinal: true }), options);
    state = finalizePendingSubtitleCue(state, { ...options, sessionTimeMs: time + 20, reason: 'test' });
  };

  appendFinalPair('Hello.', '你好。', 100);
  appendFinalPair('Next', '下一句', 200);
  assert.equal(state.finalCues.length, 2);

  state = createSubtitleCueState();
  appendFinalPair('現在', 'Now', 300);
  appendFinalPair('是麥克風測試。', 'is a microphone test.', 400);
  assert.equal(state.finalCues.length, 2);
  assert.deepEqual(state.finalCues.map((cue) => [cue.sourceText, cue.translatedText]), [[
    '現在', 'Now'
  ], [
    '是麥克風測試。', 'is a microphone test.'
  ]]);

  state = createSubtitleCueState();
  const options = { maxCueChars: 12 };
  appendFinalPair('first,', '第一，', 100, options);
  appendFinalPair('second', '第二', 200, options);
  assert.equal(state.finalCues.length, 1);
  assert.deepEqual(state.finalCues.map((cue) => cue.sourceText), ['first, second']);
});

test('merges adjacent final number fragments within the idle window without loss or duplication', () => {
  let state = createSubtitleCueState();
  const appendFinalPair = (sourceText, translatedText, time) => {
    state = applySubtitleCueEvent(state, baseEvent({ stream: 'source', text: sourceText, sessionTimeMs: time, isFinal: true }));
    state = applySubtitleCueEvent(state, baseEvent({ stream: 'translation', text: translatedText, sessionTimeMs: time + 10, isFinal: true }));
    state = finalizePendingSubtitleCue(state, { sessionTimeMs: time + 20, reason: 'test' });
  };

  appendFinalPair('1234', '1234', 100);
  appendFinalPair('567', '567', 500);
  appendFinalPair('8910', '8910', 900);

  assert.equal(state.finalCues.length, 1);
  assert.equal(state.finalCues[0].sourceText, '1234 567 8910');
  assert.equal(state.finalCues[0].translatedText, '1234 567 8910');
});

test('does not merge final Cues after sentence punctuation or after a long gap', () => {
  const appendFinalPair = (state, sourceText, translatedText, time) => {
    let next = applySubtitleCueEvent(state, baseEvent({ stream: 'source', text: sourceText, sessionTimeMs: time, isFinal: true }));
    next = applySubtitleCueEvent(next, baseEvent({ stream: 'translation', text: translatedText, sessionTimeMs: time + 10, isFinal: true }));
    return finalizePendingSubtitleCue(next, { sessionTimeMs: time + 20, reason: 'test' });
  };

  let state = createSubtitleCueState();
  state = appendFinalPair(state, 'first', '第一', 100);
  state = appendFinalPair(state, 'second.', '第二。', 500);
  state = appendFinalPair(state, 'third', '第三', 900);
  assert.deepEqual(state.finalCues.map((cue) => cue.sourceText), ['first', 'second.', 'third']);

  state = createSubtitleCueState();
  state = appendFinalPair(state, '1234', '1234', 100);
  state = appendFinalPair(state, '5678', '5678', 1800);
  assert.deepEqual(state.finalCues.map((cue) => cue.sourceText), ['1234', '5678']);
});

test('does not merge final Cues across sessions, live sessions, or segments', () => {
  const appendFinalPair = (state, scope, time) => {
    let next = applySubtitleCueEvent(state, baseEvent({ ...scope, eventId: `source-${time}`, stream: 'source', text: 'part', sessionTimeMs: time, isFinal: true }));
    next = applySubtitleCueEvent(next, baseEvent({ ...scope, eventId: `translation-${time}`, stream: 'translation', text: '片段', sessionTimeMs: time + 10, isFinal: true }));
    return finalizePendingSubtitleCue(next, { sessionTimeMs: time + 20, reason: 'test' });
  };

  let state = appendFinalPair(createSubtitleCueState(), { sessionId: 'session-1', liveSessionId: 'live-1', segmentId: 'segment-1' }, 100);
  state = appendFinalPair(state, { sessionId: 'session-2', liveSessionId: 'live-1', segmentId: 'segment-1' }, 200);
  state = appendFinalPair(state, { sessionId: 'session-2', liveSessionId: 'live-2', segmentId: 'segment-1' }, 300);
  state = appendFinalPair(state, { sessionId: 'session-2', liveSessionId: 'live-2', segmentId: 'segment-2' }, 400);

  assert.equal(state.finalCues.length, 4);
});

test('a shorter suffix transcript update does not create an extra cue', () => {
  let state = createSubtitleCueState();
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'source', text: '123', sessionTimeMs: 100 }));
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'source', text: '3', sessionTimeMs: 120 }));
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'translation', text: '123', sessionTimeMs: 140 }));

  assert.equal(state.currentCue.sourceText, '123');
  assert.equal(state.currentCue.translatedText, '123');
  assert.equal(state.finalCues.length, 0);
});

test('turnComplete control event finalizes the pending cue when text is complete enough to submit', () => {
  let state = createSubtitleCueState();
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'source', text: 'source without punctuation', sessionTimeMs: 100 }));
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'translation', text: 'translation without punctuation', sessionTimeMs: 120 }));
  state = applySubtitleCueEvent(state, { turnComplete: true, sessionTimeMs: 500 });
  state = resolveIdleSubtitleCue(state, {
    cueId: state.currentCue.cueId,
    updatedTimeMs: state.currentCue.updatedTimeMs,
    sessionTimeMs: 1200
  }).state;

  assert.equal(state.currentCue, null);
  assert.equal(state.finalCues.length, 1);
  assert.equal(state.finalCues[0].finalizedReason, 'turnComplete');
  assert.equal(state.finalCues[0].endTimeMs, 1200);
});

test('without a provider boundary a Cue stays open for late translation pairing', () => {
  let state = createSubtitleCueState();
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'source', text: 'source without punctuation', sessionTimeMs: 100 }));
  assert.equal(state.finalCues.length, 0);
  assert.equal(state.currentCue.sourceText, 'source without punctuation');

  state = applySubtitleCueEvent(state, baseEvent({ stream: 'translation', text: 'late translation', sessionTimeMs: 600 }));
  assert.equal(state.finalCues.length, 0);
  assert.equal(state.currentCue.translatedText, 'late translation');
});

test('idle finalizes a paired Cue when the provider sends no boundary', () => {
  let state = createSubtitleCueState();
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'source', text: 'source without boundary', sessionTimeMs: 100 }));
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'translation', text: 'translation without boundary', sessionTimeMs: 120 }));

  const candidate = state.currentCue;
  const beforeDebounce = resolveIdleSubtitleCue(state, {
    cueId: candidate.cueId,
    updatedTimeMs: candidate.updatedTimeMs,
    sessionTimeMs: candidate.updatedTimeMs + 699
  });
  assert.equal(beforeDebounce.action, 'waiting-for-more-text');
  assert.equal(beforeDebounce.state.currentCue.cueId, candidate.cueId);

  const resolved = resolveIdleSubtitleCue(state, {
    cueId: candidate.cueId,
    updatedTimeMs: candidate.updatedTimeMs,
    sessionTimeMs: candidate.updatedTimeMs + 700
  });
  assert.equal(resolved.action, 'finalized');
  assert.equal(resolved.state.currentCue, null);
  assert.equal(resolved.state.finalCues[0].finalizedReason, 'idle');
});

test('idle finalizes an aggregated paired Cue and rejects stale timers', () => {
  let state = createSubtitleCueState();
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'source', text: 'hello', sessionTimeMs: 100 }));
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'translation', text: 'bonjour', sessionTimeMs: 120 }));
  state = applySubtitleCueEvent(state, { turnComplete: true, sessionTimeMs: 500 });
  const version = state.currentCue.updatedTimeMs;
  const resolved = resolveIdleSubtitleCue(state, { cueId: state.currentCue.cueId, updatedTimeMs: version, sessionTimeMs: 1320 });
  assert.equal(resolved.action, 'finalized');
  assert.equal(resolved.state.finalCues[0].finalizedReason, 'turnComplete');
  assert.equal(resolved.state.currentCue, null);

  let changed = applySubtitleCueEvent(state, baseEvent({ stream: 'source', text: 'hello there', sessionTimeMs: 200 }));
  const stale = resolveIdleSubtitleCue(changed, { cueId: changed.currentCue.cueId, updatedTimeMs: version, sessionTimeMs: 1400 });
  assert.equal(stale.action, 'stale');
  assert.equal(stale.state.currentCue.sourceText, 'hello there');
});

test('merges non-cumulative transcript fragments into one turn without turnIndex', () => {
  let state = createSubtitleCueState();
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'source', text: "it's a voice", sessionTimeMs: 100 }));
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'source', text: 'input.', sessionTimeMs: 140 }));
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'translation', text: '這是語音', sessionTimeMs: 180 }));
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'translation', text: '輸入。', sessionTimeMs: 220 }));
  state = finalizePendingSubtitleCue(state, { sessionTimeMs: 300, reason: 'turnComplete' });

  assert.equal(state.finalCues.length, 1);
  assert.equal(state.currentCue, null);

  state = applySubtitleCueEvent(state, { turnComplete: true, sessionTimeMs: 300 });
  assert.deepEqual(state.finalCues.map((cue) => [cue.sourceText, cue.translatedText]), [[
    "it's a voice input.",
    '這是語音輸入。'
  ]]);
});

test('replaces cumulative updates instead of appending them', () => {
  let state = createSubtitleCueState();
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'source', text: 'hello', sessionTimeMs: 100 }));
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'source', text: 'hello world', sessionTimeMs: 120 }));
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'translation', text: '你好', sessionTimeMs: 140 }));
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'translation', text: '你好世界', sessionTimeMs: 160 }));

  assert.equal(state.currentCue.sourceText, 'hello world');
  assert.equal(state.currentCue.translatedText, '你好世界');
});

test('unrelated source events start a new Cue after a paired Cue without turnIndex', () => {
  let state = createSubtitleCueState();
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'source', text: 'first source', sessionTimeMs: 100 }));
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'translation', text: 'first translation', sessionTimeMs: 120 }));
  state = applySubtitleCueEvent(state, { turnComplete: true, sessionTimeMs: 200 });
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'source', text: 'second source', sessionTimeMs: 300 }));
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'translation', text: 'second translation', sessionTimeMs: 320 }));
  state = resolveIdleSubtitleCue(state, {
    cueId: state.pendingCues[0].cueId,
    updatedTimeMs: state.pendingCues[0].updatedTimeMs,
    sessionTimeMs: 1000
  }).state;

  assert.deepEqual(state.finalCues.map(({ sourceText, translatedText }) => [sourceText, translatedText]), [
    ['first source', 'first translation']
  ]);
  assert.deepEqual([state.currentCue.sourceText, state.currentCue.translatedText], [
    'second source', 'second translation'
  ]);
});

test('formal source after an interim paired Cue stays in a new partial Cue', () => {
  let state = createSubtitleCueState();
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'source', eventType: 'input-interim', text: 'interim source', sessionTimeMs: 100 }));
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'translation', text: 'translation', sessionTimeMs: 120 }));
  state = applySubtitleCueEvent(state, { turnComplete: true, sessionTimeMs: 150 });
  state = applySubtitleCueEvent(state, baseEvent({
    stream: 'source', eventType: 'input', text: 'formal source', sessionTimeMs: 200, isFinal: true
  }));
  state = resolveIdleSubtitleCue(state, {
    cueId: state.pendingCues[0].cueId,
    updatedTimeMs: state.pendingCues[0].updatedTimeMs,
    sessionTimeMs: 1000
  }).state;

  assert.deepEqual(state.finalCues.map(({ sourceText, translatedText }) => [sourceText, translatedText]), [
    ['interim source', 'translation']
  ]);
  assert.equal(state.currentCue.sourceText, 'formal source');
  assert.equal(state.currentCue.translatedText, '');
  assert.equal(state.currentCue.status, 'partial');
});

test('idle source-only Cue retries a bounded number of times, then reports failure', () => {
  let state = createSubtitleCueState();
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'source', text: 'source text', sessionTimeMs: 100 }));
  let result = resolveIdleSubtitleCue(state, { cueId: state.currentCue.cueId, updatedTimeMs: 100, sessionTimeMs: 1300 });
  assert.equal(result.action, 'needs-retranslation');
  assert.equal(result.state.currentCue.retranslationRequested, true);

  result = resolveIdleSubtitleCue(result.state, {
    cueId: result.state.currentCue.cueId,
    updatedTimeMs: result.state.currentCue.updatedTimeMs,
    sessionTimeMs: 2500
  });
  assert.equal(result.action, 'needs-retranslation');
  assert.equal(result.state.currentCue.sourceText, 'source text');
  assert.equal(result.state.currentCue.status, 'partial');
  assert.equal(result.state.finalCues.length, 0);

  result = resolveIdleSubtitleCue(result.state, {
    cueId: result.state.currentCue.cueId,
    updatedTimeMs: result.state.currentCue.updatedTimeMs,
    sessionTimeMs: 3700
  });
  assert.equal(result.action, 'translation-failed');
  assert.equal(result.state.currentCue.translationStatus, 'failed');
});

test('late translation fills the most recent source-only Cue without finalizing without a boundary', () => {
  let state = createSubtitleCueState();
  state = applySubtitleCueEvent(state, baseEvent({
    stream: 'source', text: 'source text', sessionTimeMs: 100
  }));
  state = resolveIdleSubtitleCue(state, {
    cueId: state.currentCue.cueId,
    updatedTimeMs: state.currentCue.updatedTimeMs,
    sessionTimeMs: 1300
  }).state;
  state = resolveIdleSubtitleCue(state, {
    cueId: state.currentCue.cueId,
    updatedTimeMs: state.currentCue.updatedTimeMs,
    sessionTimeMs: 2500
  }).state;

  state = applySubtitleCueEvent(state, baseEvent({
    stream: 'translation', text: 'translated text', sessionTimeMs: 1500
  }));

  assert.equal(state.finalCues.length, 0);
  assert.deepEqual([state.currentCue.sourceText, state.currentCue.translatedText], ['source text', 'translated text']);
});

test('late translation does not create a translation-only Cue when source-only Cue exists', () => {
  let state = createSubtitleCueState();
  state = applySubtitleCueEvent(state, baseEvent({
    stream: 'source', text: 'first source', sessionTimeMs: 100
  }));
  state = resolveIdleSubtitleCue(state, {
    cueId: state.currentCue.cueId,
    updatedTimeMs: state.currentCue.updatedTimeMs,
    sessionTimeMs: 1300
  }).state;
  state = resolveIdleSubtitleCue(state, {
    cueId: state.currentCue.cueId,
    updatedTimeMs: state.currentCue.updatedTimeMs,
    sessionTimeMs: 2500
  }).state;
  state = applySubtitleCueEvent(state, baseEvent({
    stream: 'translation', text: 'first translation', sessionTimeMs: 1500
  }));

  assert.equal(state.finalCues.length, 0);
  assert.equal(state.currentCue.translatedText, 'first translation');
});

test('idle translation-only Cue is discarded without a final Cue', () => {
  let state = createSubtitleCueState();
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'translation', text: 'hallucination', sessionTimeMs: 100 }));
  const result = resolveIdleSubtitleCue(state, { cueId: state.currentCue.cueId, updatedTimeMs: 100, sessionTimeMs: 1300 });
  assert.equal(result.action, 'discarded-translation-only');
  assert.equal(result.state.currentCue, null);
  assert.equal(result.state.finalCues.length, 0);
});

test('a long transcript gap does not finalize a continuing Cue', () => {
  let state = createSubtitleCueState();
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'source', text: 'First thought', sessionTimeMs: 100 }));
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'translation', text: 'Premiere idee', sessionTimeMs: 150 }));
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'source', text: 'First thought continues', sessionTimeMs: 1200 }));

  assert.deepEqual(state.finalCues, []);
  assert.equal(state.currentCue.sourceText, 'First thought continues');
  assert.equal(state.currentCue.translatedText, 'Premiere idee');
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

test('length overflow stays whole without an explicit safe boundary', () => {
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

  assert.equal(state.finalCues.length, 0);
  assert.equal(state.currentCue.sourceText, 'alpha beta gamma delta');
  state = finalizePendingSubtitleCue(state, { sessionTimeMs: 200, reason: 'stop' });
  assert.deepEqual(state.finalCues.map((cue) => [cue.sourceText, cue.translatedText]), [
    ['alpha beta gamma delta', 'un deux trois quatre']
  ]);
});

test('length overflow stays in one Cue when only the source can be safely split', () => {
  let state = createSubtitleCueState();
  const options = { maxCueChars: 12 };
  state = applySubtitleCueEvent(state, baseEvent({
    stream: 'source', text: 'alpha beta gamma delta', sessionTimeMs: 100
  }), options);
  state = applySubtitleCueEvent(state, baseEvent({
    stream: 'translation', text: '短翻譯', sessionTimeMs: 150
  }), options);

  assert.equal(state.finalCues.length, 0);
  state = applySubtitleCueEvent(state, { turnComplete: true, sessionTimeMs: 200 });
  state = finalizePendingSubtitleCue(state, { sessionTimeMs: 300, reason: 'turnComplete' });
  assert.deepEqual(state.finalCues.map((cue) => [cue.sourceText, cue.translatedText]), [
    ['alpha beta gamma delta', '短翻譯']
  ]);
  assert.equal(state.nextSequence, 2);
});

test('long CJK cues remain one bilingual sentence without a language limit split', () => {
  let state = createSubtitleCueState();
  const options = { minimumCueDurationMs: 20 };
  state = applySubtitleCueEvent(state, baseEvent({
    sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'ja', stream: 'source',
    text: '這是一段很長的中文字幕，應該依照子句自然分段並保留網址https://example.com/a。', sessionTimeMs: 120
  }), options);
  state = applySubtitleCueEvent(state, baseEvent({
    sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'ja', stream: 'translation',
    text: 'これは長い日本語字幕です、句読点に沿って自然に分割し、URL https://example.com/a を保ちます。', sessionTimeMs: 180
  }), options);
  state = finalizePendingSubtitleCue(state, { ...options, sessionTimeMs: 240, reason: 'stop' });

  assert.equal(state.finalCues.length, 1);
  assert.deepEqual(state.finalCues.map((cue) => cue.sequence), [1]);
  assert.equal(state.finalCues[0].startTimeMs, 120);
  assert.equal(state.finalCues[0].endTimeMs, 180);
  assert.equal(state.finalCues[0].sourceText, '這是一段很長的中文字幕，應該依照子句自然分段並保留網址https://example.com/a。');
  assert.equal(state.finalCues[0].translatedText, 'これは長い日本語字幕です、句読点に沿って自然に分割し、URL https://example.com/a を保ちます。');
});

test('split cumulative transcript events do not duplicate already committed cues', () => {
  let state = createSubtitleCueState();
  const options = { maxCueChars: 12 };
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'source', text: 'alpha beta gamma delta', sessionTimeMs: 100 }), options);
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'translation', text: 'un deux trois quatre', sessionTimeMs: 120 }), options);
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'source', text: 'alpha beta gamma delta epsilon', sessionTimeMs: 200 }), options);
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'translation', text: 'un deux trois quatre cinq', sessionTimeMs: 220, isFinal: true }), options);
  state = finalizePendingSubtitleCue(state, { sessionTimeMs: 240, reason: 'test' });

  assert.deepEqual(state.finalCues.map((cue) => cue.sourceText), ['alpha beta gamma delta epsilon']);
  assert.deepEqual(state.finalCues.map((cue) => cue.sequence), [1]);
});

test('sequence stays stable across segment rollover and does not reset timestamps', () => {
  let state = createSubtitleCueState();
  state = applySubtitleCueEvent(state, baseEvent({ segmentId: 'segment-1', stream: 'source', text: '第一句。', sessionTimeMs: 10 }));
  state = applySubtitleCueEvent(state, baseEvent({ segmentId: 'segment-1', stream: 'translation', text: 'First sentence.', sessionTimeMs: 30 }));
  state = applySubtitleCueEvent(state, { turnComplete: true, segmentId: 'segment-1', sessionTimeMs: 40 });
  state = applySubtitleCueEvent(state, baseEvent({ segmentId: 'segment-2', stream: 'source', text: '第二句。', sessionTimeMs: 70000 }));
  state = applySubtitleCueEvent(state, baseEvent({ segmentId: 'segment-2', stream: 'translation', text: 'Second sentence.', sessionTimeMs: 70100 }));
  state = applySubtitleCueEvent(state, { turnComplete: true, segmentId: 'segment-2', sessionTimeMs: 70200 });
  state = finalizePendingSubtitleCue(state, { sessionTimeMs: 71000, reason: 'test' });

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
  state = applySubtitleCueEvent(state, { turnComplete: true, sessionTimeMs: 150 });
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'source', text: 'Done.', sessionTimeMs: 200 }));
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'translation', text: 'Termine.', sessionTimeMs: 220 }));
  state = finalizePendingSubtitleCue(state, { sessionTimeMs: 300, reason: 'turnComplete' });

  assert.equal(state.finalCues.length, 1);
  assert.equal(state.currentCue, null);
});

test('cumulative transcript text updates the preceding final cue instead of creating a partial', () => {
  let state = createSubtitleCueState();
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'source', text: '你好', sessionTimeMs: 100, isFinal: true }));
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'translation', text: 'Hello', sessionTimeMs: 120, isFinal: true }));
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'source', text: '你好,你好。', sessionTimeMs: 300 }));
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'translation', text: 'Hello, hello.', sessionTimeMs: 320 }));
  state = finalizePendingSubtitleCue(state, { sessionTimeMs: 500, reason: 'test' });

  assert.equal(state.currentCue, null);
  assert.equal(state.finalCues.length, 1);
  assert.equal(state.finalCues[0].sourceText, '你好,你好。');
  assert.equal(state.finalCues[0].translatedText, 'Hello, hello.');
});

test('same text from a later turn is retained as a separate cue event', () => {
  let state = createSubtitleCueState();
  state = applySubtitleCueEvent(state, baseEvent({ eventId: 'turn-1-source', turnIndex: 1, stream: 'source', text: '123', sessionTimeMs: 100, isFinal: true }));
  state = applySubtitleCueEvent(state, baseEvent({ eventId: 'turn-1-translation', turnIndex: 1, stream: 'translation', text: '1, 2, 3', sessionTimeMs: 120, isFinal: true }));
  state = finalizePendingSubtitleCue(state, { sessionTimeMs: 140, reason: 'test' });
  state = applySubtitleCueEvent(state, baseEvent({ eventId: 'turn-2-source', turnIndex: 2, stream: 'source', text: '123', sessionTimeMs: 300, isFinal: true }));
  state = applySubtitleCueEvent(state, baseEvent({ eventId: 'turn-2-translation', turnIndex: 2, stream: 'translation', text: '1, 2, 3', sessionTimeMs: 320, isFinal: true }));
  state = finalizePendingSubtitleCue(state, { sessionTimeMs: 340, reason: 'test' });

  assert.equal(state.finalCues.length, 2);
  assert.deepEqual(state.finalCues.map((cue) => [cue.sourceText, cue.translatedText]), [
    ['123', '1, 2, 3'],
    ['123', '1, 2, 3']
  ]);
});

test('same text from later events remains separate when turnIndex is unavailable', () => {
  let state = createSubtitleCueState();
  state = applySubtitleCueEvent(state, baseEvent({ eventId: 'event-1-source', stream: 'source', text: '一二三', sessionTimeMs: 100, isFinal: true }));
  state = applySubtitleCueEvent(state, baseEvent({ eventId: 'event-1-translation', stream: 'translation', text: 'one two three', sessionTimeMs: 120, isFinal: true }));
  state = finalizePendingSubtitleCue(state, { sessionTimeMs: 140, reason: 'test' });
  state = applySubtitleCueEvent(state, baseEvent({ eventId: 'event-2-source', stream: 'source', text: '一二三', sessionTimeMs: 300, isFinal: true }));
  state = applySubtitleCueEvent(state, baseEvent({ eventId: 'event-2-translation', stream: 'translation', text: 'one two three', sessionTimeMs: 320, isFinal: true }));
  state = finalizePendingSubtitleCue(state, { sessionTimeMs: 340, reason: 'test' });

  assert.deepEqual(state.finalCues.map((cue) => [cue.sourceText, cue.translatedText]), [
    ['一二三', 'one two three'],
    ['一二三', 'one two three']
  ]);
});

test('final cumulative-looking number text is not stripped from a later turn', () => {
  let state = createSubtitleCueState();
  const appendFinalPair = (sourceText, translatedText, time) => {
    state = applySubtitleCueEvent(state, baseEvent({
      eventId: `source-${time}`, stream: 'source', text: sourceText, sessionTimeMs: time, isFinal: true
    }));
    state = applySubtitleCueEvent(state, baseEvent({
      eventId: `translation-${time}`, stream: 'translation', text: translatedText, sessionTimeMs: time + 10, isFinal: true
    }));
    state = finalizePendingSubtitleCue(state, { sessionTimeMs: time + 20, reason: 'turnComplete' });
  };

  appendFinalPair('123.', '123.', 100);
  appendFinalPair('123.', '123.', 1800);
  appendFinalPair('123.123.456', '123.123.456', 3600);

  assert.deepEqual(state.finalCues.map((cue) => [cue.sourceText, cue.translatedText]), [
    ['123.', '123.'],
    ['123.', '123.'],
    ['123.123.456', '123.123.456']
  ]);
});

test('display cues include final cues followed by the current partial cue', () => {
  let state = createSubtitleCueState();
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'source', text: 'Final source.', sessionTimeMs: 100 }));
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'translation', text: 'Final translation.', sessionTimeMs: 120 }));
  state = applySubtitleCueEvent(state, { turnComplete: true, sessionTimeMs: 150 });
  state = finalizePendingSubtitleCue(state, { sessionTimeMs: 200, reason: 'turnComplete' });
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

test('dismisses an idle incomplete Cue without touching finalized Cues', () => {
  const state = {
    ...createSubtitleCueState({ finalCues: [{ cueId: 'final-1', sequence: 1, status: 'final' }] }),
    currentCue: { cueId: 'partial-1', sequence: 2, status: 'partial', sourceText: '未完成', translatedText: '' }
  };

  const next = dismissSubtitleCue(state, 'partial-1');

  assert.equal(next.currentCue, null);
  assert.deepEqual(next.finalCues, state.finalCues);
});

test('processed event IDs stay bounded during long continuous input', () => {
  let state = createSubtitleCueState();

  for (let index = 0; index < MAX_PROCESSED_EVENT_IDS + 500; index += 1) {
    state = applySubtitleCueEvent(state, {
      eventId: `long-session-event-${index}`,
      stream: 'source',
      eventType: 'input',
      text: `source ${index}`,
      sessionTimeMs: index * 100,
      sessionId: 'session-1',
      segmentId: 'segment-1',
      sourceLanguageCode: 'zh-Hant',
      targetLanguageCode: 'en'
    });
  }

  assert.equal(state.processedEventIds.length, MAX_PROCESSED_EVENT_IDS);
  assert.equal(state.processedEventIds[0], 'long-session-event-500');
  assert.equal(state.processedEventIds.at(-1), `long-session-event-${MAX_PROCESSED_EVENT_IDS + 499}`);
});

test('restored checkpoint event IDs are trimmed to the bounded window', () => {
  const state = createSubtitleCueState({
    processedEventIds: Array.from({ length: MAX_PROCESSED_EVENT_IDS + 10 }, (_, index) => `restored-${index}`)
  });

  assert.equal(state.processedEventIds.length, MAX_PROCESSED_EVENT_IDS);
  assert.equal(state.processedEventIds[0], 'restored-10');
  assert.equal(state.processedEventIds.at(-1), `restored-${MAX_PROCESSED_EVENT_IDS + 9}`);
});

test('checkpoint reload preserves debounce and late Cue revision behavior', () => {
  const initialEvents = [
    baseEvent({ eventId: 'checkpoint-source', stream: 'source', text: '資料，今天才這個資料內容目前', sessionTimeMs: 100 }),
    baseEvent({ eventId: 'checkpoint-translation', stream: 'translation', text: 'Data, only today so far', sessionTimeMs: 110 }),
    { eventId: 'checkpoint-boundary', turnComplete: true, sessionTimeMs: 200 }
  ];
  const lateEvents = [
    baseEvent({ eventId: 'checkpoint-late-source', stream: 'source', text: '有資料才給他的。', sessionTimeMs: 1000 }),
    baseEvent({ eventId: 'checkpoint-late-translation', stream: 'translation', text: 'will be given to him.', sessionTimeMs: 1010 })
  ];
  const prepare = (events, state = createSubtitleCueState()) => events.reduce(
    (next, event) => applySubtitleCueEvent(next, event), state
  );
  const resolve = (state) => {
    const candidate = state.currentCue || state.pendingCues[0];
    return resolveIdleSubtitleCue(state, {
      cueId: candidate.cueId,
      updatedTimeMs: candidate.updatedTimeMs,
      sessionTimeMs: 900
    }).state;
  };
  let withoutReload = resolve(prepare(initialEvents));
  withoutReload = prepare(lateEvents, withoutReload);

  let withReload = resolve(prepare(initialEvents));
  withReload = createSubtitleCueState(withReload);
  withReload = prepare(lateEvents, withReload);

  assert.deepEqual(withReload.finalCues, withoutReload.finalCues);
  assert.deepEqual(withReload.pendingCues, withoutReload.pendingCues);
});

test('missing session-relative time is ignored without epoch timestamps', () => {
  const state = createSubtitleCueState();
  assert.equal(applySubtitleCueEvent(state, { ...baseEvent(), text: 'no clock' }), state);
  assert.equal(applySubtitleCueEvent(state, { ...baseEvent(), text: 'no clock', now: Date.now() }), state);
});

test('minimum duration and gap normalize final cue timeline', () => {
  let state = createSubtitleCueState();
  const options = { minimumGapMs: 5, minimumCueDurationMs: 300 };
  state = applySubtitleCueEvent(state, baseEvent({ eventId: 's1', stream: 'source', text: 'one.', sessionTimeMs: 100 }), options);
  state = applySubtitleCueEvent(state, baseEvent({ eventId: 't1', stream: 'translation', text: 'uno.', sessionTimeMs: 110, isFinal: true }), options);
  state = applySubtitleCueEvent(state, { eventId: 'boundary-1', turnComplete: true, sessionTimeMs: 120 });
  state = applySubtitleCueEvent(state, baseEvent({ eventId: 's2', stream: 'source', text: 'two.', sessionTimeMs: 130 }), options);
  state = applySubtitleCueEvent(state, baseEvent({ eventId: 't2', stream: 'translation', text: 'dos.', sessionTimeMs: 132, isFinal: true }), options);
  state = finalizePendingSubtitleCue(state, { ...options, sessionTimeMs: 400, reason: 'turnComplete' });

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
  const firstCandidate = state.currentCue || state.pendingCues[0];
  state = resolveIdleSubtitleCue(state, {
    cueId: firstCandidate.cueId,
    updatedTimeMs: firstCandidate.updatedTimeMs,
    sessionTimeMs: 800
  }).state;
  assert.equal(state.finalCues.length, 1);
  assert.equal(state.finalCues[0].finalizedReason, 'turnComplete');

  state = createSubtitleCueState();
  state = applySubtitleCueEvent(state, baseEvent({ eventId: 'generation', generationComplete: true, sessionTimeMs: 5 }));
  state = applySubtitleCueEvent(state, baseEvent({ eventId: 'source-2', stream: 'source', text: 'source', sessionTimeMs: 10 }));
  state = applySubtitleCueEvent(state, baseEvent({ eventId: 'translation-2', stream: 'translation', text: 'translation', sessionTimeMs: 12 }));
  const secondCandidate = state.currentCue || state.pendingCues[0];
  state = resolveIdleSubtitleCue(state, {
    cueId: secondCandidate.cueId,
    updatedTimeMs: secondCandidate.updatedTimeMs,
    sessionTimeMs: 800
  }).state;
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

test('normalizer marks late input and output transcript events as final', () => {
  const events = normalizeGeminiLiveCueEvents({
    eventId: 'late-provider-42',
    serverContent: {
      inputTranscription: { text: 'late source' },
      outputTranscription: { text: 'late translation' }
    }
  }, {
    liveSessionId: 'live-1',
    sessionTimeMs: 123,
    eventSequence: 8,
    inputTranscriptIsFinal: true,
    outputTranscriptIsFinal: true,
    inputTranscriptArrivedAfterBoundary: true,
    outputTranscriptArrivedAfterBoundary: true
  });

  assert.deepEqual(events.map((event) => [event.stream, event.isFinal]), [
    ['source', true],
    ['translation', true]
  ]);
  assert.equal(events[0].isLateTranscript, true);
  assert.equal(events[1].isLateTranscript, true);
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
