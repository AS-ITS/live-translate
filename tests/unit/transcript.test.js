import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyTranscriptEvent,
  createTranscriptState,
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
