import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyGlossaryCorrectionToCue,
  applyGlossaryReplacements,
  correctTranslationForSource
} from '../../src/lib/glossaryReplacement.js';
import { mergeMeetingGlossaryEntries } from '../../src/lib/meetingGlossary.js';

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

test('Cue correction retains glossary-corrected initial translation when refinement replaces it with a generic term', () => {
  const cue = applyGlossaryCorrectionToCue({
    cueId: 'cue-1',
    status: 'final',
    sourceText: 'Acme 已核准。',
    rawTranslation: 'Acme approved.',
    initialTranslation: 'Meeting Acme approved.',
    refinedTranslation: 'The company approved.',
    refinement: { status: 'completed' }
  }, [{ source: 'Acme', target: 'Meeting Acme', replacementAliases: [] }]);

  assert.equal(cue.cueId, 'cue-1');
  assert.equal(cue.rawTranslation, 'Acme approved.');
  assert.equal(cue.initialTranslation, 'Meeting Acme approved.');
  assert.equal(cue.refinedTranslation, 'Meeting Acme approved.');
});

test('exact-source dictionary hits canonicalize every provider variant to one target', () => {
  const glossaryEntries = [{ source: '你好', target: 'su3cl3', replacementAliases: ['Hello'] }];

  for (const translatedText of ['Hello.', 'Hello. su3cl3.', 'su3cl3.', 'su3cl3. su3cl3.']) {
    assert.equal(
      correctTranslationForSource({ sourceText: '你好', translatedText }, glossaryEntries),
      'su3cl3.'
    );
  }
});

test('sentence glossary correction preserves provider target repetitions without inventing missing ones', () => {
  const glossaryEntries = [{ source: '哈囉', target: 'Hello', replacementAliases: [] }];

  assert.equal(
    correctTranslationForSource({
      sourceText: '哈囉哈囉哈囉。',
      translatedText: 'Hello, hello, hello.'
    }, glossaryEntries),
    'Hello, hello, hello.'
  );
  assert.equal(
    correctTranslationForSource({
      sourceText: '哈囉哈囉哈囉。',
      translatedText: 'Hello.'
    }, glossaryEntries),
    'Hello.'
  );
});

test('sentence glossary correction removes only adjacent alias-target duplicates', () => {
  const glossaryEntries = [{ source: '你好', target: 'su3cl3', replacementAliases: ['Hello'] }];

  assert.equal(
    correctTranslationForSource({
      sourceText: '你好你好',
      translatedText: 'Hello. su3cl3. Hello. su3cl3.'
    }, glossaryEntries),
    'su3cl3. su3cl3.'
  );
  assert.equal(
    correctTranslationForSource({
      sourceText: '你好，歡迎參加會議',
      translatedText: 'Hello, su3cl3, welcome to the meeting.'
    }, glossaryEntries),
    'su3cl3, welcome to the meeting.'
  );
});

test('sentence glossary correction preserves case punctuation and independent glossary targets', () => {
  const glossaryEntries = [
    { source: '你好', target: 'Su3Cl3', replacementAliases: ['hello'] },
    { source: '會議', target: 'Gathering', replacementAliases: ['meeting'] }
  ];

  assert.equal(
    correctTranslationForSource({
      sourceText: '你好你好，會議會議。',
      translatedText: 'HELLO! Su3Cl3! su3cl3; Su3Cl3. meeting, Gathering; gathering.'
    }, glossaryEntries),
    'Su3Cl3! su3cl3; Su3Cl3. Gathering; gathering.'
  );
});

test('meeting dictionary override removes the obsolete global target and duplicate required target', () => {
  const glossaryEntries = mergeMeetingGlossaryEntries(
    [{ source: '你好', target: 'HelloGlobal', replacementAliases: [] }],
    [{ source: '你好', target: 'su3cl3', replacementAliases: [] }],
    'en'
  );

  assert.deepEqual(glossaryEntries, [{
    source: '你好',
    target: 'su3cl3',
    replacementAliases: ['HelloGlobal']
  }]);
  assert.equal(
    correctTranslationForSource({ sourceText: '你好', translatedText: 'HelloGlobal. su3cl3.' }, glossaryEntries),
    'su3cl3.'
  );
});

test('sentence dictionary hits replace adjacent aliases without deleting provider targets', () => {
  const glossaryEntries = [{
    source: '你好',
    target: 'su3cl3',
    replacementAliases: ['Hello', 'HelloGlobal']
  }];

  for (const [translatedText, expected] of [
    ["Hello, su3cl3, welcome to today's meeting.", "su3cl3, welcome to today's meeting."],
    ["HelloGlobal, su3cl3, su3cl3, welcome to today's meeting.", "su3cl3, su3cl3, welcome to today's meeting."]
  ]) {
    const corrected = correctTranslationForSource({
      sourceText: '你好，歡迎參加今天的會議',
      translatedText
    }, glossaryEntries);
    assert.equal(corrected, expected);
    assert.equal(corrected.includes('Hello'), false);
  }
});

test('partial final and refined updates keep one canonical target on the same cue', () => {
  const glossaryEntries = [{ source: '你好', target: 'su3cl3', replacementAliases: ['Hello'] }];
  const partialTranslation = correctTranslationForSource({
    sourceText: '你好',
    translatedText: 'Hello. su3cl3.'
  }, glossaryEntries);
  const finalCue = applyGlossaryCorrectionToCue({
    cueId: 'cue-dictionary-1',
    status: 'final',
    rawSource: '你好',
    rawTranslation: 'Hello. su3cl3.',
    translatedText: 'Hello. su3cl3.'
  }, glossaryEntries);
  const refinedCue = applyGlossaryCorrectionToCue({
    ...finalCue,
    refinedTranslation: 'su3cl3. su3cl3.'
  }, glossaryEntries);

  assert.equal(partialTranslation, 'su3cl3.');
  assert.equal(finalCue.cueId, 'cue-dictionary-1');
  assert.equal(finalCue.initialTranslation, 'su3cl3.');
  assert.equal(refinedCue.cueId, 'cue-dictionary-1');
  assert.equal(refinedCue.initialTranslation, 'su3cl3.');
  assert.equal(refinedCue.refinedTranslation, 'su3cl3.');
  assert.equal(refinedCue.rawTranslation, 'Hello. su3cl3.');
});
