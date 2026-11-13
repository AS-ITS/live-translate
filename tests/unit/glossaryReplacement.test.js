import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyGlossaryCorrectionToCue,
  applyGlossaryCorrectionsToCueState,
  applyGlossaryReplacements,
  correctTranslationForSource,
  glossaryCorrectionForSource
} from '../../src/lib/glossaryReplacement.js';
import { cueRefinementInputHash, effectiveTranslationForCue } from '../../src/lib/cueContent.js';

function liveCue(cue) {
  return {
    ...cue,
    initialTranslation: cue.initialTranslation ?? cue.rawTranslation ?? cue.translatedText,
    translationVersion: cue.translationVersion ?? 1,
    translationProvenance: cue.translationProvenance ?? {
      audioTurnId: 'turn-1', turnKey: 'turn-1', connectionEpoch: 1,
      providerEpoch: 1, eventSequence: cue.translationVersion ?? 1
    }
  };
}

test('cue-state correction resolves the snapshot owned by each historical Cue', () => {
  const cueA = {
    cueId: 'cue-a', status: 'final', sourceText: '你好', rawTranslation: 'Hello.',
    translatedText: 'Hello.', correctionGlossaryRevision: 'revision-a'
  };
  const cueB = {
    cueId: 'cue-b', status: 'final', sourceText: '你好', rawTranslation: 'Hello.',
    translatedText: 'Hello.', correctionGlossaryRevision: 'revision-b'
  };
  const snapshots = new Map([
    ['revision-a', [{ source: '你好', target: 'A', replacementAliases: ['Hello'] }]],
    ['revision-b', [{ source: '你好', target: 'B', replacementAliases: ['Hello'] }]]
  ]);
  const result = applyGlossaryCorrectionsToCueState(
    { finalCues: [cueA, cueB], refinedSubtitleCues: [] },
    [],
    { entriesForCue: (cue) => snapshots.get(cue.correctionGlossaryRevision) || [] }
  );
  assert.deepEqual(result.finalCues.map((cue) => effectiveTranslationForCue(cue)), ['Hello.', 'Hello.']);
  assert.deepEqual(result.finalCues, [cueA, cueB]);
});
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
  assert.equal(correctTranslationForSource({ sourceText: '你好。', translatedText: 'Hi.' }, entries), 'speak Hi');
  assert.equal(correctTranslationForSource({ sourceText: '你好。', translatedText: 'Hello.' }, [
    { source: '你好', target: 'speak Hi', replacementAliases: [] }
  ]), 'speak Hi');
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

test('Cue correction preserves Gemini Initial and exposes bound Refined translation', () => {
  const cue = applyGlossaryCorrectionToCue(liveCue({
    cueId: 'cue-1',
    status: 'final',
    sourceText: '你好。',
    translatedText: 'Hi.',
    rawTranslation: 'Hi.'
  }), [{ source: '你好', target: 'speak Hi', replacementAliases: ['Hi'] }]);
  assert.equal(cue.rawTranslation, 'Hi.');
  assert.equal(cue.translatedText, 'Hi.');
  assert.equal(cue.initialTranslation, 'Hi.');
  assert.equal(effectiveTranslationForCue(cue), 'speak Hi');
  assert.equal(cue.refinement.inputHash, cueRefinementInputHash(cue));
});

test('legacy Cue with unbound Refined retains original data and falls back to Initial', () => {
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
  assert.equal(cue.refinedTranslation, 'The company approved.');
  assert.equal(cue.glossaryCorrectionStatus, undefined);
  assert.equal(effectiveTranslationForCue(cue), 'Meeting Acme approved.');
});

test('complete unique source uses the dictionary target regardless of provider wording', () => {
  const glossaryEntries = [{ source: '你好', target: 'su3cl3', replacementAliases: ['Hello'] }];

  for (const [translatedText, expected] of [
    ['Hello.', 'su3cl3'],
    ['Hello. su3cl3.', 'su3cl3'],
    ['su3cl3.', 'su3cl3'],
    ['su3cl3. su3cl3.', 'su3cl3']
  ]) {
    assert.equal(
      correctTranslationForSource({ sourceText: '你好', translatedText }, glossaryEntries),
      expected
    );
  }
});

test('punctuated full sentence corrects only translation and survives a later refinement', () => {
  const original = liveCue({
    cueId: 'single-sentence', status: 'final', sourceText: '你好。', rawSource: '你好。',
    translatedText: 'Hello.', rawTranslation: 'Hello.'
  });
  const entries = [{ source: '你好', target: 'su3cl3' }];
  const corrected = applyGlossaryCorrectionToCue(original, entries);
  assert.equal(corrected.rawSource, '你好。');
  assert.equal(original.rawTranslation, 'Hello.');
  assert.equal(effectiveTranslationForCue(corrected), 'su3cl3');
  assert.equal(corrected.refinement.inputHash, cueRefinementInputHash(corrected));

  const refined = applyGlossaryCorrectionToCue({ ...corrected, refinedTranslation: 'Greetings.' }, entries,
    { refineOnly: true });
  assert.equal(refined.rawSource, '你好。');
  assert.equal(refined.initialTranslation, 'Hello.');
  assert.equal(refined.refinedTranslation, 'su3cl3');
  assert.equal(effectiveTranslationForCue(refined), 'su3cl3');
});

test('full sentence replacement requires one unambiguous source entry', () => {
  const sourceText = ' 你好。  ';
  assert.equal(correctTranslationForSource({ sourceText, translatedText: 'Hello.' },
    [{ source: '你好', target: 'su3cl3' }]), 'su3cl3');
  assert.equal(correctTranslationForSource({ sourceText, translatedText: 'Hello.' },
    [{ source: '你好', target: 'su3cl3' }, { source: '你好。', target: 'another' }]), 'Hello.');
  assert.equal(correctTranslationForSource({ sourceText: '你好，歡迎參加今天的會議。', translatedText: 'Hello, welcome.' },
    [{ source: '你好', target: 'su3cl3' }]), 'Hello, welcome.');
  assert.equal(correctTranslationForSource({ sourceText: '你好，歡迎。', translatedText: 'Hello, welcome.' },
    [{ source: '你好，歡迎', target: 'su3cl3' }]), 'Hello, welcome.');
  assert.equal(correctTranslationForSource({ sourceText, translatedText: 'Hello.' },
    [{ source: '別的詞', target: 'other' }]), 'Hello.');
});

test('glossary-only sources preserve every longest non-overlapping occurrence', () => {
  const glossaryEntries = [{ source: '你好', target: 'su3cl3', replacementAliases: ['Hello'] }];
  const fixtures = [
    ['你好', 'Hello.', 'su3cl3'],
    ['你好你好', 'Hello, hello.', 'su3cl3, su3cl3.'],
    ['你好你好', 'su3cl3.', 'su3cl3.'],
    ['你好你好', 'Hello, su3cl3.', 'su3cl3, su3cl3.']
  ];

  for (const [sourceText, translatedText, expected] of fixtures) {
    assert.equal(
      correctTranslationForSource({ sourceText, translatedText }, glossaryEntries),
      expected
    );
  }
  assert.equal(glossaryCorrectionForSource({ sourceText: '你好你好', translatedText: 'su3cl3.' }, glossaryEntries).status,
    'correction_uncertain');
});

test('no-glossary translations remain byte-for-byte unchanged', () => {
  for (const translatedText of ['Hello, hello, hello.', 'hello.']) {
    assert.equal(
      correctTranslationForSource({ sourceText: '你好', translatedText }, []),
      translatedText
    );
  }
});

test('source occurrence matching is longest-first, case-insensitive, and punctuation preserving', () => {
  const glossaryEntries = [
    { source: '你好', target: 'SHORT' },
    { source: '你好你好', target: 'LONG' },
    { source: 'Acme', target: 'BRAND' }
  ];

  const result = glossaryCorrectionForSource({
      sourceText: '你好你好！ACME acme。',
      translatedText: 'Any provider wording.'
    }, glossaryEntries);
  assert.equal(result.translatedText, 'Any provider wording.');
  assert.equal(result.status, 'correction_uncertain');
  assert.deepEqual(result.occurrences.map(({ source }) => source), ['你好你好', 'Acme', 'Acme']);
});

test('mixed sources correct a safely aligned term inside a longer sentence', () => {
  const input = {
    sourceText: '想請教他你好，歡迎會議。',
    translatedText: 'I would like to ask him hello, welcome to the meeting.'
  };
  const glossaryEntries = [{ source: '你好', target: 'su3cl3', replacementAliases: ['Hello'] }];
  const correction = glossaryCorrectionForSource(input, glossaryEntries);
  const cue = applyGlossaryCorrectionToCue(liveCue({
    cueId: 'cue-mixed',
    status: 'final',
    rawSource: input.sourceText,
    rawTranslation: input.translatedText,
    translatedText: input.translatedText
  }), glossaryEntries);

  assert.equal(correction.translatedText, 'I would like to ask him su3cl3, welcome to the meeting.');
  assert.equal(correction.status, 'corrected');
  assert.equal(cue.initialTranslation, input.translatedText);
  assert.equal(effectiveTranslationForCue(cue), correction.translatedText);
  assert.equal(cue.glossaryCorrectionStatus, 'corrected');
});

test('sentence glossary correction preserves provider wording and reports missing occurrences', () => {
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
  assert.equal(glossaryCorrectionForSource({ sourceText: '哈囉哈囉哈囉。', translatedText: 'Hello.' }, glossaryEntries).status,
    'correction_uncertain');
});

test('sentence glossary correction preserves unaligned alias-target repetitions', () => {
  const glossaryEntries = [{ source: '你好', target: 'su3cl3', replacementAliases: ['Hello'] }];

  assert.equal(
    correctTranslationForSource({
      sourceText: '你好你好',
      translatedText: 'Hello. su3cl3. Hello. su3cl3.'
    }, glossaryEntries),
    'Hello. su3cl3. Hello. su3cl3.'
  );
  assert.equal(
    correctTranslationForSource({
      sourceText: '你好，歡迎參加會議',
      translatedText: 'Hello, su3cl3, welcome to the meeting.'
    }, glossaryEntries),
    'Hello, su3cl3, welcome to the meeting.'
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
    'HELLO! Su3Cl3! su3cl3; Su3Cl3. meeting, Gathering; gathering.'
  );
});

test('meeting dictionary override keeps provider wording when alias and target exceed source matches', () => {
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
    'su3cl3'
  );
});

test('sentence dictionary hits replace adjacent aliases without deleting provider targets', () => {
  const glossaryEntries = [{
    source: '你好',
    target: 'su3cl3',
    replacementAliases: ['Hello', 'HelloGlobal']
  }];

  for (const [translatedText, expected] of [
    ["Hello, su3cl3, welcome to today's meeting.", "Hello, su3cl3, welcome to today's meeting."],
    ["HelloGlobal, su3cl3, su3cl3, welcome to today's meeting.", "HelloGlobal, su3cl3, su3cl3, welcome to today's meeting."]
  ]) {
    const corrected = correctTranslationForSource({
      sourceText: '你好，歡迎參加今天的會議',
      translatedText
    }, glossaryEntries);
    assert.equal(corrected, expected);
    assert.equal(
      glossaryCorrectionForSource({
        sourceText: '你好，歡迎參加今天的會議',
        translatedText
      }, glossaryEntries).status,
      'correction_uncertain'
    );
  }
});

test('partial final and refined updates preserve unaligned provider repetitions on the same cue', () => {
  const glossaryEntries = [{ source: '你好', target: 'su3cl3', replacementAliases: ['Hello'] }];
  const partialTranslation = correctTranslationForSource({
    sourceText: '你好',
    translatedText: 'Hello. su3cl3.'
  }, glossaryEntries);
  const finalCue = applyGlossaryCorrectionToCue(liveCue({
    cueId: 'cue-dictionary-1',
    status: 'final',
    rawSource: '你好',
    rawTranslation: 'Hello. su3cl3.',
    translatedText: 'Hello. su3cl3.'
  }), glossaryEntries);
  const refinedCue = applyGlossaryCorrectionToCue({
    ...finalCue,
    refinedTranslation: 'su3cl3. su3cl3.'
  }, glossaryEntries);

  assert.equal(partialTranslation, 'su3cl3');
  assert.equal(finalCue.cueId, 'cue-dictionary-1');
  assert.equal(finalCue.initialTranslation, 'Hello. su3cl3.');
  assert.equal(refinedCue.cueId, 'cue-dictionary-1');
  assert.equal(refinedCue.initialTranslation, 'Hello. su3cl3.');
  assert.equal(refinedCue.refinedTranslation, 'su3cl3');
  assert.equal(refinedCue.rawTranslation, 'Hello. su3cl3.');
});

test('partial final and late-final corrections always restart from provider raw translation', () => {
  const glossaryEntries = [{ source: '你好', target: 'su3cl3', replacementAliases: ['Hello'] }];
  const sourceText = '你好你好';
  const partialRaw = 'Hello.';
  const partial = correctTranslationForSource({ sourceText, translatedText: partialRaw }, glossaryEntries);
  const finalCue = applyGlossaryCorrectionToCue(liveCue({
    cueId: 'cue-revision-1',
    status: 'final',
    rawSource: sourceText,
    rawTranslation: 'Hello, hello.',
    translatedText: 'Hello, hello.',
    sourceVersion: 1,
    translationVersion: 2
  }), glossaryEntries);
  const lateFinalCue = applyGlossaryCorrectionToCue({
    ...finalCue,
    rawTranslation: 'su3cl3.',
    translatedText: 'su3cl3.',
    initialTranslation: 'su3cl3.',
    translationVersion: 3,
    translationProvenance: { ...finalCue.translationProvenance, eventSequence: 3 }
  }, glossaryEntries);

  assert.equal(partialRaw, 'Hello.');
  assert.equal(partial, 'su3cl3.');
  assert.equal(glossaryCorrectionForSource({ sourceText, translatedText: partialRaw }, glossaryEntries).status,
    'correction_uncertain');
  assert.equal(finalCue.rawTranslation, 'Hello, hello.');
  assert.equal(finalCue.initialTranslation, 'Hello, hello.');
  assert.equal(effectiveTranslationForCue(finalCue), 'su3cl3, su3cl3.');
  assert.equal(lateFinalCue.rawTranslation, 'su3cl3.');
  assert.equal(lateFinalCue.initialTranslation, 'su3cl3.');
  assert.equal(effectiveTranslationForCue(lateFinalCue), 'su3cl3.');
  assert.equal(lateFinalCue.glossaryCorrectionStatus, 'correction_uncertain');
  assert.equal(lateFinalCue.translationVersion, 3);
});
