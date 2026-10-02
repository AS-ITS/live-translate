import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyGlossaryCorrectionToCue,
  applyGlossaryReplacements,
  correctTranslationForSource
} from '../../src/lib/glossaryReplacement.js';

test('glossary replacement handles source terms, legacy aliases, repeated matches, and longest-first ordering', () => {
  const entries = [
    { source: 'microphone', target: 'Alan speak', replacementAliases: ['mic'] },
    { source: 'mic stand', target: 'Alan speak stand', replacementAliases: [] }
  ];

  assert.equal(
    applyGlossaryReplacements('microphone and mic near mic stand. microphone works.', entries),
    'Alan speak and Alan speak near Alan speak stand. Alan speak works.'
  );
});

test('glossary replacement supports source-only entries from the simplified UI', () => {
  assert.equal(
    applyGlossaryReplacements('microphone check', [{ source: 'microphone', target: 'Alan speak' }]),
    'Alan speak check'
  );
});

test('glossary replacement treats candidates as literal strings', () => {
  assert.equal(
    applyGlossaryReplacements('a.b aXb', [{ source: 'a.b', target: 'term', replacementAliases: [] }]),
    'term aXb'
  );
});

test('source-aware glossary correction matches bare and punctuated source terms', () => {
  const entries = [{ source: '你好', target: 'speak Hi', replacementAliases: ['Hi'] }];
  assert.equal(correctTranslationForSource({ sourceText: '你好', translatedText: 'Hi' }, entries), 'speak Hi');
  assert.equal(correctTranslationForSource({ sourceText: '你好。', translatedText: 'Hi.' }, entries), 'speak Hi.');
  assert.equal(correctTranslationForSource({ sourceText: '你好。', translatedText: 'Hello.' }, [
    { source: '你好', target: 'speak Hi', replacementAliases: [] }
  ]), 'speak Hi.');
});

test('source-aware correction never replaces an alias in an unrelated Cue', () => {
  const entries = [{ source: '你好', target: 'speak Hi', replacementAliases: ['Hi'] }];
  assert.equal(
    correctTranslationForSource({ sourceText: '今天討論歷史。', translatedText: 'Hi appears in this unrelated sentence.' }, entries),
    'Hi appears in this unrelated sentence.'
  );
  assert.equal(
    correctTranslationForSource({ sourceText: 'this is unrelated', translatedText: 'hello' }, [
      { source: 'hi', target: 'greeting', replacementAliases: ['hello'] }
    ]),
    'hello'
  );
});

test('Cue correction preserves provider translation and exposes corrected initial translation', () => {
  const cue = applyGlossaryCorrectionToCue({
    cueId: 'cue-1',
    status: 'final',
    sourceText: '你好。',
    translatedText: 'Hi.',
    rawTranslation: 'Hi.'
  }, [{ source: '你好', target: 'speak Hi', replacementAliases: ['Hi'] }]);
  assert.equal(cue.rawTranslation, 'Hi.');
  assert.equal(cue.translatedText, 'Hi.');
  assert.equal(cue.initialTranslation, 'speak Hi.');
});
