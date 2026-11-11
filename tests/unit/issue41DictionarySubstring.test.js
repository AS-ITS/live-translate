import assert from 'node:assert/strict';
import test from 'node:test';
import { applyGlossaryCorrectionToCue, glossaryCorrectionForSource, glossaryReplacementForText } from '../../src/lib/glossaryReplacement.js';
import { effectiveTranslationForCue } from '../../src/lib/cueContent.js';

const entry = { source: '會議', target: 'session', replacementAliases: ['meeting'] };

test('Chinese term at sentence start, middle, and end aligns to provider wording', () => {
  for (const sourceText of ['會議現在開始', '今天的會議開始', '現在開始會議']) {
    assert.deepEqual(
      glossaryCorrectionForSource({ sourceText, translatedText: 'The meeting starts now.' }, [entry]),
      { translatedText: 'The session starts now.', status: 'corrected', occurrences: [{
        start: sourceText.indexOf('會議'), end: sourceText.indexOf('會議') + 2,
        entryOrder: 0, source: '會議', target: 'session'
      }] }
    );
  }
});

test('missing alignment preserves Gemini text and reports uncertainty', () => {
  const result = glossaryCorrectionForSource(
    { sourceText: '今天的會議開始', translatedText: 'We are starting now.' }, [entry]
  );
  assert.equal(result.translatedText, 'We are starting now.');
  assert.equal(result.status, 'correction_uncertain');
});

test('partial alignment keeps safe replacements and reports missing occurrences', () => {
  const entries = [{ source: '你好', target: 'su3cl3', replacementAliases: ['Hello'] }];
  const partial = glossaryCorrectionForSource(
    { sourceText: '你好你好', translatedText: 'Hello.' }, entries
  );
  assert.equal(partial.translatedText, 'su3cl3.');
  assert.equal(partial.status, 'correction_uncertain');
  const alreadyCorrect = glossaryCorrectionForSource(
    { sourceText: '你好你好', translatedText: 'su3cl3.' }, entries
  );
  assert.equal(alreadyCorrect.translatedText, 'su3cl3.');
  assert.equal(alreadyCorrect.status, 'correction_uncertain');
});

test('English boundaries and longest source match are preserved', () => {
  const entries = [
    { source: 'mic', target: 'SHORT', replacementAliases: [] },
    { source: 'mic stand', target: 'LONG', replacementAliases: [] }
  ];
  const result = glossaryCorrectionForSource(
    { sourceText: 'The mic stand is near a microphone.', translatedText: 'The mic stand is near a microphone.' },
    entries
  );
  assert.equal(result.translatedText, 'The LONG is near a microphone.');
  assert.equal(result.occurrences.length, 1);
  assert.equal(result.occurrences[0].source, 'mic stand');
});

test('multiple terms replace once from original translation without recursive replacement', () => {
  const entries = [
    { source: '會議', target: 'briefing', replacementAliases: ['meeting'] },
    { source: '報告', target: 'meeting', replacementAliases: ['report'] }
  ];
  const result = glossaryCorrectionForSource(
    { sourceText: '會議中的報告', translatedText: 'The meeting includes a report.' }, entries
  );
  assert.equal(result.translatedText, 'The briefing includes a meeting.');
  assert.equal(result.status, 'corrected');
});

test('Final Cue correction preserves provider evidence and version', () => {
  const cue = { cueId: 'cue-1', status: 'final', sourceText: '今天的會議開始',
 translatedText: 'The meeting starts now.', rawTranslation: 'The meeting starts now.',
 initialTranslation: 'The meeting starts now.', translationVersion: 3,
 translationProvenance: { eventId: 'provider-3', connectionEpoch: 1,
 providerEpoch: 1, eventSequence: 3 } };
  const corrected = applyGlossaryCorrectionToCue(cue, [entry]);
 assert.equal(corrected.initialTranslation, 'The meeting starts now.');
 assert.equal(effectiveTranslationForCue(corrected), 'The session starts now.');
  assert.equal(corrected.rawTranslation, cue.rawTranslation);
  assert.equal(corrected.translatedText, cue.translatedText);
  assert.equal(corrected.translationVersion, 3);
  assert.deepEqual(corrected.translationProvenance, cue.translationProvenance);
});

test('source replacement uses longest match and original left-to-right ranges', () => {
  const entries = [
    { source: '智慧', target: 'Intelligence' },
    { source: '人工智慧', target: 'Artificial Intelligence' },
    { source: '發展', target: 'developing' }
  ];
  assert.deepEqual(glossaryReplacementForText('人工智慧正在發展', entries), {
    text: 'Artificial Intelligence正在developing', status: 'corrected'
  });
  assert.equal(glossaryReplacementForText('人工智慧人工智慧', entries).text,
    'Artificial IntelligenceArtificial Intelligence');
});

test('source replacement never chains or cycles', () => {
  assert.equal(glossaryReplacementForText('A', [
    { source: 'A', target: 'B' }, { source: 'B', target: 'C' }
  ]).text, 'B');
  assert.equal(glossaryReplacementForText('A B', [
    { source: 'A', target: 'B' }, { source: 'B', target: 'A' }
  ]).text, 'B A');
});

test('same source span with different translations reports ambiguity', () => {
  const entries = [{ source: '人工智慧', target: 'AI' },
    { source: '人工智慧', target: 'Artificial Intelligence' }];
  assert.deepEqual(glossaryReplacementForText('人工智慧', entries), {
    text: '人工智慧', status: 'correction_ambiguous'
  });
  const correction = glossaryCorrectionForSource(
    { sourceText: '人工智慧', translatedText: 'Artificial intelligence.' }, entries);
  assert.equal(correction.status, 'correction_ambiguous');
  assert.equal(correction.translatedText, 'Artificial intelligence.');
});

test('partial and final restart from raw provider text', () => {
  const entries = [{ source: '會議', target: 'session', replacementAliases: ['meeting'] }];
  const partial = glossaryCorrectionForSource(
    { sourceText: '會議開始', translatedText: 'Meeting starts.' }, entries);
  const final = glossaryCorrectionForSource(
    { sourceText: '會議開始', translatedText: 'The meeting starts now.' }, entries);
  assert.equal(partial.translatedText, 'session starts.');
  assert.equal(final.translatedText, 'The session starts now.');
  assert.equal(glossaryCorrectionForSource(
    { sourceText: '會議開始', translatedText: partial.translatedText }, entries).translatedText,
    partial.translatedText);
});
