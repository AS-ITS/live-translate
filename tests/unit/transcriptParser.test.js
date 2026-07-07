import assert from 'node:assert/strict';
import test from 'node:test';
import { createTranscriptState, transcriptText, updateTranscript } from '../fixtures/transcriptParser.js';

test('transcript parser keeps partial text separate from final text', () => {
  const state = updateTranscript(createTranscriptState(), { text: 'hello wor', isFinal: false });

  assert.deepEqual(state, {
    finalText: '',
    partialText: 'hello wor'
  });
  assert.equal(transcriptText(state), 'hello wor');
});

test('transcript parser appends final text and clears partial text', () => {
  const first = updateTranscript(createTranscriptState(), { text: 'hello', isFinal: true });
  const second = updateTranscript(first, { text: 'world', isFinal: true });

  assert.deepEqual(second, {
    finalText: 'hello world',
    partialText: ''
  });
  assert.equal(transcriptText(second), 'hello world');
});

test('transcript parser ignores blank updates', () => {
  const state = { finalText: 'existing', partialText: 'partial' };

  assert.equal(updateTranscript(state, { text: '   ', isFinal: true }), state);
  assert.equal(updateTranscript(state, {}, ), state);
});
