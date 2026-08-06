import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applySubtitleCueEvent,
  createSubtitleCueState,
  finalizePendingSubtitleCue,
  resolveIdleSubtitleCue,
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

test('sentence punctuation does not finalize a short cue before provider completion', () => {
  let state = createSubtitleCueState();
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'source', text: 'Hello', sessionTimeMs: 100 }));
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'source', text: 'Hello world.', sessionTimeMs: 200 }));
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'translation', text: 'Bonjour le monde.', sessionTimeMs: 260 }));

  assert.equal(state.finalCues.length, 0);
  assert.equal(state.currentCue.sourceText, 'Hello world.');
  assert.equal(state.currentCue.translatedText, 'Bonjour le monde.');

  state = applySubtitleCueEvent(state, { turnComplete: true, sessionTimeMs: 400 });
  assert.equal(state.currentCue, null);
  assert.deepEqual(state.finalCues.map(({ sourceText, translatedText, finalizedReason }) => ({
    sourceText, translatedText, finalizedReason
  })), [{
    sourceText: 'Hello world.',
    translatedText: 'Bonjour le monde.',
    finalizedReason: 'turnComplete'
  }]);
});

test('merges adjacent short bilingual cues until sentence punctuation', () => {
  let state = createSubtitleCueState();
  const appendFinalPair = (sourceText, translatedText, time) => {
    state = applySubtitleCueEvent(state, baseEvent({ stream: 'source', text: sourceText, sessionTimeMs: time, isFinal: true }));
    state = applySubtitleCueEvent(state, baseEvent({ stream: 'translation', text: translatedText, sessionTimeMs: time + 10, isFinal: true }));
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
  assert.equal(state.finalCues[0].endTimeMs, 1002);
  assert.equal(state.nextSequence, 4);
});

test('does not merge after sentence punctuation or across the language limit', () => {
  let state = createSubtitleCueState();
  const appendFinalPair = (sourceText, translatedText, time, options = {}) => {
    state = applySubtitleCueEvent(state, baseEvent({ stream: 'source', text: sourceText, sessionTimeMs: time, isFinal: true }), options);
    state = applySubtitleCueEvent(state, baseEvent({ stream: 'translation', text: translatedText, sessionTimeMs: time + 10, isFinal: true }), options);
  };

  appendFinalPair('Hello.', '你好。', 100);
  appendFinalPair('Next', '下一句', 200);
  assert.equal(state.finalCues.length, 2);

  state = createSubtitleCueState();
  appendFinalPair('現在', 'Now', 300);
  appendFinalPair('是麥克風測試。', 'is a microphone test.', 400);
  assert.equal(state.finalCues.length, 1);
  assert.deepEqual(state.finalCues.map((cue) => [cue.sourceText, cue.translatedText]), [[
    '現在是麥克風測試。', 'Now is a microphone test.'
  ]]);

  state = createSubtitleCueState();
  const options = { maxCueChars: 12 };
  appendFinalPair('first,', '第一，', 100, options);
  appendFinalPair('second', '第二', 200, options);
  assert.equal(state.finalCues.length, 2);
  assert.deepEqual(state.finalCues.map((cue) => cue.sourceText), ['first,', 'second']);
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

  assert.equal(state.currentCue, null);
  assert.equal(state.finalCues.length, 1);
  assert.equal(state.finalCues[0].finalizedReason, 'turnComplete');
  assert.equal(state.finalCues[0].endTimeMs, 500);
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

test('idle finalizes an aggregated paired Cue and rejects stale timers', () => {
  let state = createSubtitleCueState();
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'source', text: 'hello', sessionTimeMs: 100 }));
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'translation', text: 'bonjour', sessionTimeMs: 120 }));
  const version = state.currentCue.updatedTimeMs;
  const resolved = resolveIdleSubtitleCue(state, { cueId: state.currentCue.cueId, updatedTimeMs: version, sessionTimeMs: 1320 });
  assert.equal(resolved.action, 'finalized');
  assert.equal(resolved.state.finalCues[0].finalizedReason, 'idle');
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

  assert.equal(state.finalCues.length, 0);
  assert.equal(state.currentCue.sourceText, "it's a voice input.");
  assert.equal(state.currentCue.translatedText, '這是語音輸入。');

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
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'source', text: 'second source', sessionTimeMs: 300 }));
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'translation', text: 'second translation', sessionTimeMs: 320 }));

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
  state = applySubtitleCueEvent(state, baseEvent({
    stream: 'source', eventType: 'input', text: 'formal source', sessionTimeMs: 200, isFinal: true
  }));

  assert.deepEqual(state.finalCues.map(({ sourceText, translatedText }) => [sourceText, translatedText]), [
    ['interim source', 'translation']
  ]);
  assert.equal(state.currentCue.sourceText, 'formal source');
  assert.equal(state.currentCue.translatedText, '');
  assert.equal(state.currentCue.status, 'partial');
});

test('idle source-only Cue requests one retranslation, then remains partial on retry timeout', () => {
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
  assert.equal(result.action, 'waiting-for-translation');
  assert.equal(result.state.currentCue.sourceText, 'source text');
  assert.equal(result.state.currentCue.status, 'partial');
  assert.equal(result.state.finalCues.length, 0);
});

test('late translation fills the most recent source-only Cue and finalizes it', () => {
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

  assert.equal(state.currentCue, null);
  assert.deepEqual(state.finalCues.map(({ sourceText, translatedText }) => [sourceText, translatedText]), [
    ['source text', 'translated text']
  ]);
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

  assert.equal(state.finalCues.length, 1);
  assert.equal(state.finalCues[0].translatedText, 'first translation');
  assert.equal(state.currentCue, null);
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

test('length overflow splits an aligned bilingual cue at word boundaries', () => {
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
    ['alpha beta', 'un deux', 'length'],
    ['gamma delta', 'trois quatre', 'length']
  ]);
  assert.equal(state.currentCue, null);
  assert.equal(state.nextSequence, 3);
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

  assert.equal(state.finalCues.length, 1);
  state = applySubtitleCueEvent(state, { turnComplete: true, sessionTimeMs: 200 });
  assert.deepEqual(state.finalCues.map((cue) => [cue.sourceText, cue.translatedText]), [
    ['alpha beta gamma delta', '短翻譯']
  ]);
  assert.equal(state.nextSequence, 2);
});

test('language limits split CJK cues while preserving protected tokens and session time', () => {
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

  assert.ok(state.finalCues.length > 1);
  assert.deepEqual(state.finalCues.map((cue) => cue.sequence), [1, 2, 3]);
  assert.ok(state.finalCues.every((cue, index) => index === 0 || cue.startTimeMs > state.finalCues[index - 1].endTimeMs));
  assert.equal(state.finalCues.map((cue) => cue.sourceText).join(''), '這是一段很長的中文字幕，應該依照子句自然分段並保留網址https://example.com/a。');
  assert.ok(state.finalCues.map((cue) => cue.translatedText).join(' ').includes('https://example.com/a'));
});

test('split cumulative transcript events do not duplicate already committed cues', () => {
  let state = createSubtitleCueState();
  const options = { maxCueChars: 12 };
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'source', text: 'alpha beta gamma delta', sessionTimeMs: 100 }), options);
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'translation', text: 'un deux trois quatre', sessionTimeMs: 120 }), options);
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'source', text: 'alpha beta gamma delta epsilon', sessionTimeMs: 200 }), options);
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'translation', text: 'un deux trois quatre cinq', sessionTimeMs: 220, isFinal: true }), options);

  assert.deepEqual(state.finalCues.map((cue) => cue.sourceText), ['alpha beta', 'gamma delta', 'epsilon']);
  assert.deepEqual(state.finalCues.map((cue) => cue.sequence), [1, 2, 3]);
});

test('sequence stays stable across segment rollover and does not reset timestamps', () => {
  let state = createSubtitleCueState();
  state = applySubtitleCueEvent(state, baseEvent({ segmentId: 'segment-1', stream: 'source', text: '第一句。', sessionTimeMs: 10 }));
  state = applySubtitleCueEvent(state, baseEvent({ segmentId: 'segment-1', stream: 'translation', text: 'First sentence.', sessionTimeMs: 30 }));
  state = applySubtitleCueEvent(state, { turnComplete: true, segmentId: 'segment-1', sessionTimeMs: 40 });
  state = applySubtitleCueEvent(state, baseEvent({ segmentId: 'segment-2', stream: 'source', text: '第二句。', sessionTimeMs: 70000 }));
  state = applySubtitleCueEvent(state, baseEvent({ segmentId: 'segment-2', stream: 'translation', text: 'Second sentence.', sessionTimeMs: 70100 }));
  state = applySubtitleCueEvent(state, { turnComplete: true, segmentId: 'segment-2', sessionTimeMs: 70200 });

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

  assert.equal(state.finalCues.length, 1);
  assert.equal(state.currentCue, null);
});

test('cumulative transcript text updates the preceding final cue instead of creating a partial', () => {
  let state = createSubtitleCueState();
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'source', text: '你好', sessionTimeMs: 100, isFinal: true }));
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'translation', text: 'Hello', sessionTimeMs: 120, isFinal: true }));
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'source', text: '你好,你好。', sessionTimeMs: 300 }));
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'translation', text: 'Hello, hello.', sessionTimeMs: 320 }));

  assert.equal(state.currentCue, null);
  assert.equal(state.finalCues.length, 1);
  assert.equal(state.finalCues[0].sourceText, '你好,你好。');
  assert.equal(state.finalCues[0].translatedText, 'Hello, hello.');
});

test('same text from a later turn is retained as a separate cue event', () => {
  let state = createSubtitleCueState();
  state = applySubtitleCueEvent(state, baseEvent({ eventId: 'turn-1-source', turnIndex: 1, stream: 'source', text: '123', sessionTimeMs: 100, isFinal: true }));
  state = applySubtitleCueEvent(state, baseEvent({ eventId: 'turn-1-translation', turnIndex: 1, stream: 'translation', text: '1, 2, 3', sessionTimeMs: 120, isFinal: true }));
  state = applySubtitleCueEvent(state, baseEvent({ eventId: 'turn-2-source', turnIndex: 2, stream: 'source', text: '123', sessionTimeMs: 300, isFinal: true }));
  state = applySubtitleCueEvent(state, baseEvent({ eventId: 'turn-2-translation', turnIndex: 2, stream: 'translation', text: '1, 2, 3', sessionTimeMs: 320, isFinal: true }));

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
  state = applySubtitleCueEvent(state, baseEvent({ eventId: 'event-2-source', stream: 'source', text: '一二三', sessionTimeMs: 300, isFinal: true }));
  state = applySubtitleCueEvent(state, baseEvent({ eventId: 'event-2-translation', stream: 'translation', text: 'one two three', sessionTimeMs: 320, isFinal: true }));

  assert.deepEqual(state.finalCues.map((cue) => [cue.sourceText, cue.translatedText]), [
    ['一二三', 'one two three'],
    ['一二三', 'one two three']
  ]);
});

test('display cues include final cues followed by the current partial cue', () => {
  let state = createSubtitleCueState();
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'source', text: 'Final source.', sessionTimeMs: 100 }));
  state = applySubtitleCueEvent(state, baseEvent({ stream: 'translation', text: 'Final translation.', sessionTimeMs: 120 }));
  state = applySubtitleCueEvent(state, { turnComplete: true, sessionTimeMs: 150 });
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
    outputTranscriptIsFinal: true
  });

  assert.deepEqual(events.map((event) => [event.stream, event.isFinal]), [
    ['source', true],
    ['translation', true]
  ]);
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
