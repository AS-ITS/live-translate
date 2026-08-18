import assert from 'node:assert/strict';
import test from 'node:test';
import {
  allocateSubtitleResegmentedCueTimes,
  stableSubtitleGroup,
  validateSubtitleResegmentationResponse
} from '../../src/lib/subtitleResegmentation.js';

const cues = [
  { cueId: 'cue-10', sequence: 10, status: 'final', startTimeMs: 1000, endTimeMs: 2400, sourceText: '語音 測試。', translatedText: 'test.', sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en' },
  { cueId: 'cue-11', sequence: 11, status: 'final', startTimeMs: 2400, endTimeMs: 4200, sourceText: 'voice test,', translatedText: 'voice test.', sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en' }
];

test('stable group includes adjacent final cues and excludes partial or untranslated cues', () => {
  assert.deepEqual(stableSubtitleGroup([...cues, { ...cues[1], cueId: 'partial', status: 'partial' }, { ...cues[1], cueId: 'empty', translatedText: '' }]).map((cue) => cue.cueId), ['cue-10', 'cue-11']);
});

test('resegmentation validates complete ordered source cue coverage', () => {
  assert.deepEqual(validateSubtitleResegmentationResponse({ refinedCues: [{ sourceCueIds: ['cue-10', 'cue-11'], refinedSource: '語音測試。', refinedTranslation: 'Voice test.' }] }, cues), [{ sourceCueIds: ['cue-10', 'cue-11'], sequence: 10, refinedSource: '語音測試。', refinedTranslation: 'Voice test.' }]);
  assert.throws(() => validateSubtitleResegmentationResponse({ refinedCues: [{ sourceCueIds: ['unknown'], refinedSource: 'x', refinedTranslation: 'x' }] }, cues), /provider_invalid_response/);
  assert.throws(() => validateSubtitleResegmentationResponse({ refinedCues: [] }, cues), /provider_invalid_response/);
});

test('app allocates one stable cue over the complete original time window', () => {
  const refined = allocateSubtitleResegmentedCueTimes(cues, [{ sourceCueIds: ['cue-10', 'cue-11'], refinedSource: '語音測試。', refinedTranslation: 'Voice test.' }], { groupHash: 'group-hash' });
  assert.equal(refined.length, 1);
  assert.deepEqual(refined[0].sourceCueIds, ['cue-10', 'cue-11']);
  assert.equal(refined[0].startTimeMs, 1000);
  assert.equal(refined[0].endTimeMs, 4200);
});

test('short resegmented outputs merge until minimum display duration is possible', () => {
  const refined = allocateSubtitleResegmentedCueTimes(cues, [
    { sourceCueIds: ['cue-10'], refinedSource: '語音。', refinedTranslation: 'Voice.' },
    { sourceCueIds: ['cue-11'], refinedSource: '測試。', refinedTranslation: 'Test.' }
  ], { minimumCueDurationMs: 300 });
  assert.ok(refined.every((cue) => cue.endTimeMs - cue.startTimeMs >= 300));
});
