import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyTranscriptEvent,
  buildTranscriptArticleParagraphs,
  createTranscriptState,
  describeTranscriptSegmentDecision,
  formatTranscriptArticleText,
  finalizePendingTranscriptItems,
  resetTranscriptState,
  transcriptItemsForStream,
  transcriptTextForStream
} from '../../src/lib/transcript.js';

test('append final transcript', () => {
  const state = applyTranscriptEvent(createTranscriptState(), {
    stream: 'source',
    text: 'hello',
    isFinal: true,
    now: 100
  });

  assert.equal(transcriptTextForStream(state, 'source'), 'hello');
  assert.deepEqual(transcriptItemsForStream(state, 'source'), [
    {
      id: 'source-1',
      stream: 'source',
      status: 'final',
      text: 'hello',
      sequence: 1,
      startedAt: 100,
      finalizedAt: 100
    }
  ]);
});

test('preserves explicit multi-language source detection metadata without changing source text', () => {
  const text = 'Hello，こんにちは，您好';
  const state = applyTranscriptEvent(createTranscriptState(), {
    stream: 'source',
    text,
    isFinal: true,
    sourceLanguageDetection: {
      detectedLanguageCodes: ['en', 'ja', 'zh-Hant'],
      coverage: 'complete'
    },
    now: 100
  });

  assert.deepEqual(transcriptItemsForStream(state, 'source'), [
    {
      id: 'source-1',
      stream: 'source',
      status: 'final',
      text,
      sequence: 1,
      startedAt: 100,
      finalizedAt: 100,
      sourceLanguageDetection: {
        detectedLanguageCodes: ['en', 'ja', 'zh-Hant'],
        coverage: 'complete'
      }
    }
  ]);
});

test('update partial transcript', () => {
  const first = applyTranscriptEvent(createTranscriptState(), {
    stream: 'source',
    text: 'hello wor',
    isFinal: false,
    now: 100
  });
  const second = applyTranscriptEvent(first, {
    stream: 'source',
    text: 'hello world',
    isFinal: false,
    now: 200
  });

  assert.equal(transcriptTextForStream(second, 'source'), 'hello world');
  assert.deepEqual(transcriptItemsForStream(second, 'source'), [
    {
      id: 'source-1',
      stream: 'source',
      status: 'partial',
      text: 'hello world',
      sequence: 1,
      startedAt: 100,
      finalizedAt: undefined
    }
  ]);
  assert.equal(second.nextSequence, 2);
});

test('partial followed by final', () => {
  const partial = applyTranscriptEvent(createTranscriptState(), {
    stream: 'source',
    text: 'hello wor',
    isFinal: false,
    now: 100
  });
  const final = applyTranscriptEvent(partial, {
    stream: 'source',
    text: 'hello world',
    isFinal: true,
    now: 200
  });

  assert.equal(transcriptTextForStream(final, 'source'), 'hello world');
  assert.deepEqual(final.source.currentPartial, null);
  assert.deepEqual(final.source.finalItems, [
    {
      id: 'source-1',
      stream: 'source',
      status: 'final',
      text: 'hello world',
      sequence: 1,
      startedAt: 100,
      finalizedAt: 200
    }
  ]);
  assert.equal(final.nextSequence, 2);
});

test('finalizes pending transcript items when a session stops', () => {
  const sourcePartial = applyTranscriptEvent(createTranscriptState(), {
    stream: 'source',
    text: 'source awaiting final',
    isFinal: false,
    now: 100
  });
  const bothPartials = applyTranscriptEvent(sourcePartial, {
    stream: 'translation',
    text: 'translation awaiting final',
    isFinal: false,
    now: 150
  });
  const finalized = finalizePendingTranscriptItems(bothPartials, { now: 200 });

  assert.equal(finalized.source.currentPartial, null);
  assert.equal(finalized.translation.currentPartial, null);
  assert.deepEqual(transcriptItemsForStream(finalized, 'source').map((item) => [item.text, item.status, item.finalizedAt]), [
    ['source awaiting final', 'final', 200]
  ]);
  assert.deepEqual(transcriptItemsForStream(finalized, 'translation').map((item) => [item.text, item.status, item.finalizedAt]), [
    ['translation awaiting final', 'final', 200]
  ]);
});

test('finalizes only pending source transcript items when requested', () => {
  const sourcePartial = applyTranscriptEvent(createTranscriptState(), {
    stream: 'source',
    text: 'source awaiting idle final',
    isFinal: false,
    now: 100
  });
  const bothPartials = applyTranscriptEvent(sourcePartial, {
    stream: 'translation',
    text: 'translation still pending',
    isFinal: false,
    now: 150
  });
  const finalized = finalizePendingTranscriptItems(bothPartials, { streams: ['source'], now: 300 });

  assert.equal(finalized.source.currentPartial, null);
  assert.equal(finalized.translation.currentPartial.text, 'translation still pending');
  assert.deepEqual(finalized.source.finalItems, [{
    id: 'source-1',
    stream: 'source',
    status: 'final',
    text: 'source awaiting idle final',
    sequence: 1,
    startedAt: 100,
    finalizedAt: 300
  }]);
  assert.deepEqual(finalized.translation.finalItems, []);
});

test('finalizes only pending translation transcript items when requested', () => {
  const sourcePartial = applyTranscriptEvent(createTranscriptState(), {
    stream: 'source',
    text: 'source still pending',
    isFinal: false,
    now: 100
  });
  const bothPartials = applyTranscriptEvent(sourcePartial, {
    stream: 'translation',
    text: 'translation awaiting idle final',
    isFinal: false,
    languageCode: 'ja',
    now: 150
  });
  const finalized = finalizePendingTranscriptItems(bothPartials, { streams: ['translation'], now: 350 });

  assert.equal(finalized.source.currentPartial.text, 'source still pending');
  assert.equal(finalized.translation.currentPartial, null);
  assert.deepEqual(finalized.source.finalItems, []);
  assert.deepEqual(finalized.translation.finalItems, [{
    id: 'translation-2',
    stream: 'translation',
    status: 'final',
    text: 'translation awaiting idle final',
    sequence: 2,
    startedAt: 150,
    finalizedAt: 350,
    languageCode: 'ja'
  }]);
});

test('ignore empty transcript', () => {
  const state = applyTranscriptEvent(createTranscriptState(), {
    stream: 'source',
    text: 'existing',
    isFinal: true,
    now: 100
  });

  assert.equal(applyTranscriptEvent(state, { stream: 'source', text: '   ', isFinal: true }), state);
  assert.equal(applyTranscriptEvent(state, { stream: 'source' }), state);
  assert.equal(transcriptTextForStream(state, 'source'), 'existing');
});

test('keep source and translation separate', () => {
  const source = applyTranscriptEvent(createTranscriptState(), {
    stream: 'source',
    text: 'hello',
    isFinal: true,
    now: 100
  });
  const translation = applyTranscriptEvent(source, {
    stream: 'translation',
    text: 'bonjour',
    isFinal: true,
    languageCode: 'fr',
    now: 200
  });

  assert.equal(transcriptTextForStream(translation, 'source'), 'hello');
  assert.equal(transcriptTextForStream(translation, 'translation'), 'bonjour');
  assert.equal(translation.source.finalItems[0].sequence, 1);
  assert.equal(translation.translation.finalItems[0].sequence, 2);
  assert.equal(translation.translation.finalItems[0].languageCode, 'fr');
});

test('preserve ordering', () => {
  const first = applyTranscriptEvent(createTranscriptState(), {
    stream: 'source',
    text: 'one',
    isFinal: true,
    now: 100
  });
  const second = applyTranscriptEvent(first, {
    stream: 'source',
    text: 'two',
    isFinal: true,
    now: 200
  });
  const third = applyTranscriptEvent(second, {
    stream: 'source',
    text: 'three',
    isFinal: false,
    now: 300
  });

  assert.deepEqual(transcriptItemsForStream(third, 'source').map((item) => item.sequence), [1, 2, 3]);
  assert.equal(transcriptTextForStream(third, 'source'), 'one two three');
});

test('avoid duplicate final append', () => {
  const first = applyTranscriptEvent(createTranscriptState(), {
    stream: 'source',
    text: 'hello',
    isFinal: true,
    now: 100
  });
  const duplicate = applyTranscriptEvent(first, {
    stream: 'source',
    text: 'hello',
    isFinal: true,
    now: 200
  });

  assert.equal(transcriptTextForStream(duplicate, 'source'), 'hello');
  assert.equal(transcriptItemsForStream(duplicate, 'source').length, 1);
  assert.equal(duplicate.nextSequence, 2);
});

test('keeps identical final text from a later provider event as a new segment', () => {
  let state = applyTranscriptEvent(createTranscriptState(), {
    stream: 'source', text: '一二三', isFinal: true, eventId: 'turn-1', now: 100
  });
  state = applyTranscriptEvent(state, {
    stream: 'source', text: '一二三', isFinal: true, eventId: 'turn-2', now: 300
  });

  assert.deepEqual(transcriptItemsForStream(state, 'source').map((item) => item.text), ['一二三', '一二三']);
  assert.deepEqual(transcriptItemsForStream(state, 'source').map((item) => item.eventId), ['turn-1', 'turn-2']);
});

test('does not strip repeated cumulative-looking text from a final later turn', () => {
  let state = createTranscriptState();
  for (const [text, now] of [['123.', 100], ['123.', 1800]]) {
    state = applyTranscriptEvent(state, {
      stream: 'source', text, isFinal: true, eventId: `turn-${now}`, now
    });
  }

  state = applyTranscriptEvent(state, {
    stream: 'source', text: '123.123.456', isFinal: true, eventId: 'turn-3600', now: 3600
  });

  assert.deepEqual(transcriptItemsForStream(state, 'source').map((item) => item.text), [
    '123.', '123.', '123.123.456'
  ]);
});

test('deduplicates identical final text from the same provider event', () => {
  let state = applyTranscriptEvent(createTranscriptState(), {
    stream: 'source', text: '一二三', isFinal: true, eventId: 'turn-1', now: 100
  });
  state = applyTranscriptEvent(state, {
    stream: 'source', text: '一二三', isFinal: true, eventId: 'turn-1', now: 200
  });

  assert.equal(transcriptItemsForStream(state, 'source').length, 1);
});

test('a repeated final does not discard the next pending segment', () => {
  const first = applyTranscriptEvent(createTranscriptState(), {
    stream: 'source', text: 'first segment', isFinal: true, now: 100
  });
  const pending = applyTranscriptEvent(first, {
    stream: 'source', text: 'second segment', isFinal: false, now: 200
  });
  const duplicate = applyTranscriptEvent(pending, {
    stream: 'source', text: 'first segment', isFinal: true, now: 300
  });

  assert.deepEqual(duplicate.source.finalItems.map((item) => item.text), ['first segment']);
  assert.equal(duplicate.source.currentPartial.text, 'second segment');
});

test('a repeated partial after final does not create a new pending segment', () => {
  const final = applyTranscriptEvent(createTranscriptState(), {
    stream: 'translation', text: 'completed translation', isFinal: true, now: 100
  });
  const duplicate = applyTranscriptEvent(final, {
    stream: 'translation', text: 'completed translation', isFinal: false, now: 200
  });

  assert.equal(duplicate, final);
  assert.equal(duplicate.translation.currentPartial, null);
});

test('final does not overwrite previous final', () => {
  const first = applyTranscriptEvent(createTranscriptState(), {
    stream: 'source',
    text: 'hello',
    isFinal: true,
    now: 100
  });
  const partial = applyTranscriptEvent(first, {
    stream: 'source',
    text: 'new par',
    isFinal: false,
    now: 200
  });
  const final = applyTranscriptEvent(partial, {
    stream: 'source',
    text: 'new part',
    isFinal: true,
    now: 300
  });

  assert.equal(transcriptTextForStream(final, 'source'), 'hello new part');
  assert.deepEqual(final.source.finalItems.map((item) => item.text), ['hello', 'new part']);
});

test('accumulates completed source and translation segments while keeping each current partial separate', () => {
  let state = createTranscriptState();
  for (const event of [
    { stream: 'source', text: '第一句', isFinal: true, now: 100 },
    { stream: 'translation', text: '第一句翻譯', isFinal: true, now: 110 },
    { stream: 'source', text: '第二句', isFinal: true, now: 200 },
    { stream: 'translation', text: '第二句翻譯', isFinal: true, now: 210 },
    { stream: 'source', text: '第三句', isFinal: true, now: 300 },
    { stream: 'translation', text: '第三句翻譯', isFinal: true, now: 310 },
    { stream: 'source', text: '第四句辨識中', isFinal: false, now: 400 },
    { stream: 'translation', text: '第四句翻譯中', isFinal: false, now: 410 }
  ]) {
    state = applyTranscriptEvent(state, event);
  }

  assert.deepEqual(state.source.finalItems.map((item) => item.text), ['第一句', '第二句', '第三句']);
  assert.equal(state.source.currentPartial.text, '第四句辨識中');
  assert.deepEqual(state.translation.finalItems.map((item) => item.text), ['第一句翻譯', '第二句翻譯', '第三句翻譯']);
  assert.equal(state.translation.currentPartial.text, '第四句翻譯中');
});

test('segments real-style partial-only turns without relying on turn completion', () => {
  let state = createTranscriptState();
  for (const event of [
    { stream: 'source', text: '第一句', isFinal: false, now: 100 },
    { stream: 'translation', text: '第一句翻譯', isFinal: false, now: 110 },
    { stream: 'source', text: '第二句', isFinal: false, now: 900 },
    { stream: 'translation', text: '第二句翻譯', isFinal: false, now: 910 },
    { stream: 'source', text: '第三句', isFinal: false, now: 1700 },
    { stream: 'translation', text: '第三句翻譯', isFinal: false, now: 1710 }
  ]) {
    state = applyTranscriptEvent(state, event);
  }

  assert.deepEqual(state.source.finalItems.map((item) => item.text), ['第一句', '第二句']);
  assert.equal(state.source.currentPartial.text, '第三句');
  assert.deepEqual(state.translation.finalItems.map((item) => item.text), ['第一句翻譯', '第二句翻譯']);
  assert.equal(state.translation.currentPartial.text, '第三句翻譯');

  const stopped = finalizePendingTranscriptItems(state, { now: 2500 });
  assert.deepEqual(stopped.source.finalItems.map((item) => item.text), ['第一句', '第二句', '第三句']);
  assert.deepEqual(stopped.translation.finalItems.map((item) => item.text), ['第一句翻譯', '第二句翻譯', '第三句翻譯']);
});

test('keeps cumulative partial extensions in one pending segment until finalization', () => {
  let state = createTranscriptState();
  state = applyTranscriptEvent(state, { stream: 'translation', text: '這是', isFinal: false, now: 100 });

  const extensionDecision = describeTranscriptSegmentDecision(state, {
    stream: 'translation',
    text: '這是一個完整句末',
    isFinal: false,
    now: 1000
  });
  state = applyTranscriptEvent(state, {
    stream: 'translation',
    text: '這是一個完整句末',
    isFinal: false,
    now: 1000
  });

  assert.equal(extensionDecision.action, 'partial');
  assert.equal(extensionDecision.segmentText, '這是一個完整句末');
  assert.deepEqual(state.translation.finalItems, []);
  assert.equal(state.translation.currentPartial.text, '這是一個完整句末');
  assert.equal(state.nextSequence, 2);
});

test('keeps cumulative full text together instead of splitting on punctuation', () => {
  let state = createTranscriptState();
  state = applyTranscriptEvent(state, { stream: 'source', text: '第一句。', isFinal: false, now: 100 });

  const secondDecision = describeTranscriptSegmentDecision(state, {
    stream: 'source',
    text: '第一句。第二句。',
    isFinal: false,
    now: 200
  });
  state = applyTranscriptEvent(state, {
    stream: 'source',
    text: '第一句。第二句。',
    isFinal: false,
    now: 200
  });
  state = applyTranscriptEvent(state, {
    stream: 'source',
    text: '第一句。第二句。第三句',
    isFinal: false,
    now: 300
  });

  assert.equal(secondDecision.action, 'partial');
  assert.equal(secondDecision.segmentText, '第一句。第二句。');
  assert.deepEqual(state.source.finalItems, []);
  assert.equal(state.source.currentPartial.text, '第一句。第二句。第三句');

  const duplicate = applyTranscriptEvent(state, {
    stream: 'source',
    text: '第一句。第二句。第三句',
    isFinal: false,
    now: 400
  });
  assert.equal(duplicate, state);
});

test('a shorter suffix update is ignored while the same partial is active', () => {
  let state = applyTranscriptEvent(createTranscriptState(), {
    stream: 'source', text: '123', isFinal: false, now: 100
  });
  const next = applyTranscriptEvent(state, {
    stream: 'source', text: '3', isFinal: false, now: 120
  });

  assert.equal(next, state);
  assert.equal(next.source.currentPartial.text, '123');
});

test('finalizing cumulative pending text preserves the full sentence ending in article text', () => {
  let state = createTranscriptState();
  state = applyTranscriptEvent(state, {
    stream: 'translation',
    text: '這是',
    isFinal: false,
    now: 100
  });
  state = applyTranscriptEvent(state, {
    stream: 'translation',
    text: '這是一個完整句末',
    isFinal: false,
    now: 1000
  });

  const finalized = finalizePendingTranscriptItems(state, { streams: ['translation'], now: 1500 });

  assert.deepEqual(finalized.translation.finalItems.map((item) => item.text), ['這是一個完整句末']);
  assert.equal(formatTranscriptArticleText(finalized.translation.finalItems), '這是一個完整句末');
});

test('article paragraphs use only final items and preserve sequence order', () => {
  const paragraphs = buildTranscriptArticleParagraphs([
    articleItem({ text: 'pending item', status: 'partial', sequence: 2 }),
    articleItem({ text: 'third', sequence: 3 }),
    articleItem({ text: 'first', sequence: 1 })
  ]);

  assert.deepEqual(paragraphs, ['first third']);
});

test('article paragraphs split on explicit blank lines', () => {
  const paragraphs = buildTranscriptArticleParagraphs([
    articleItem({ text: 'first paragraph\n\nsecond paragraph', sequence: 1 })
  ]);

  assert.deepEqual(paragraphs, ['first paragraph', 'second paragraph']);
});

test('article paragraphs merge single subtitle line breaks within a paragraph', () => {
  const paragraphs = buildTranscriptArticleParagraphs([
    articleItem({ text: 'first sentence\nsecond sentence\nthird sentence', sequence: 1 })
  ]);

  assert.deepEqual(paragraphs, ['first sentence second sentence third sentence']);
});

test('article paragraphs keep short speech gaps in the same paragraph', () => {
  const paragraphs = buildTranscriptArticleParagraphs([
    articleItem({ text: 'before short pause', sequence: 1, startedAt: 0, finalizedAt: 100 }),
    articleItem({ text: 'after short pause', sequence: 2, startedAt: 3100, finalizedAt: 3200 })
  ]);

  assert.deepEqual(paragraphs, ['before short pause after short pause']);
});

test('article paragraphs apply the same short-gap grouping to translated items', () => {
  const paragraphs = buildTranscriptArticleParagraphs([
    articleItem({ stream: 'translation', text: 'translated before short pause', sequence: 1, startedAt: 0, finalizedAt: 100 }),
    articleItem({ stream: 'translation', text: 'translated after short pause', sequence: 2, startedAt: 3100, finalizedAt: 3200 })
  ]);

  assert.deepEqual(paragraphs, ['translated before short pause translated after short pause']);
});

test('article paragraphs split after paragraph-length pauses', () => {
  const paragraphs = buildTranscriptArticleParagraphs([
    articleItem({ text: 'before paragraph pause', sequence: 1, startedAt: 0, finalizedAt: 100 }),
    articleItem({ text: 'after paragraph pause', sequence: 2, startedAt: 8100, finalizedAt: 8200 })
  ]);

  assert.deepEqual(paragraphs, ['before paragraph pause', 'after paragraph pause']);
});

test('article paragraphs keep short finalized segments in one readable paragraph', () => {
  const paragraphs = buildTranscriptArticleParagraphs([
    articleItem({ text: 'one', sequence: 1 }),
    articleItem({ text: 'two', sequence: 2 }),
    articleItem({ text: 'three', sequence: 3 }),
    articleItem({ text: 'four', sequence: 4 })
  ]);

  assert.deepEqual(paragraphs, ['one two three four']);
});

test('article paragraphs merge CJK subtitle segments without inserted spaces', () => {
  const paragraphs = buildTranscriptArticleParagraphs([
    articleItem({ text: '第一句', sequence: 1 }),
    articleItem({ text: '第二句', sequence: 2 }),
    articleItem({ text: '第三句', sequence: 3 })
  ]);

  assert.deepEqual(paragraphs, ['第一句第二句第三句']);
});

test('article paragraphs remove extra subtitle whitespace consistently', () => {
  const paragraphs = buildTranscriptArticleParagraphs([
    articleItem({ text: '  Hello    world  ', sequence: 1 }),
    articleItem({ text: '你 好   世 界', sequence: 2 })
  ]);

  assert.deepEqual(paragraphs, ['Hello world 你好世界']);
});

test('article paragraphs split before exceeding max character count', () => {
  const longText = 'x'.repeat(900);
  const paragraphs = buildTranscriptArticleParagraphs([
    articleItem({ text: longText, sequence: 1 }),
    articleItem({ text: 'next', sequence: 2 })
  ]);

  assert.deepEqual(paragraphs, [longText, 'next']);
});

test('article text joins paragraphs with blank lines for copy and export', () => {
  const text = formatTranscriptArticleText([
    articleItem({ text: 'first\n\nsecond', sequence: 1 }),
    articleItem({ text: 'third', sequence: 2, startedAt: 9000, finalizedAt: 9100 })
  ]);

  assert.equal(text, 'first\n\nsecond\n\nthird');
});

test('reset clears transcript state', () => {
  const populated = applyTranscriptEvent(createTranscriptState(), {
    stream: 'source',
    text: 'hello',
    isFinal: true,
    now: 100
  });
  const reset = resetTranscriptState(populated);

  assert.deepEqual(reset, createTranscriptState());
});

function articleItem(overrides = {}) {
  return {
    id: `item-${overrides.sequence ?? 1}`,
    stream: 'source',
    status: 'final',
    text: 'text',
    sequence: 1,
    startedAt: 0,
    finalizedAt: 100,
    ...overrides
  };
}
