import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileDurableCues } from '../../src/lib/meetingLocalTranscript.js';
import { mergeFinalCue } from '../../src/domain/subtitleCue/index.js';

const cue = (changes = {}) => ({
  cueId: 'cue-1', sessionId: 'session-1', segmentId: 'segment-1', sequence: 1,
  startTimeMs: 0, endTimeMs: 100, sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en',
  sourceText: 'old source', translatedText: 'translation', sourceVersion: 1,
  translationVersion: 1, sourceStatus: 'finalized', translationStatus: 'finalized',
  status: 'final', finalizedReason: 'final', revision: 1,
  audioTurnId: 'turn-1', providerEventSequence: 1, ...changes
});

test('reload uses Local Cue revision after proven correction', () => {
  const prior = cue();
  const local = cue({ revision: 2, sourceVersion: 2, sourceText: 'corrected source',
    providerEventSequence: 2 });
  assert.deepEqual(reconcileDurableCues([prior], [local]), [local]);
});

test('reload rejects an ahead or conflicting checkpoint Cue', () => {
  const prior = cue();
  const newer = cue({ revision: 2, sourceVersion: 2, sourceText: 'corrected source',
    providerEventSequence: 2 });
  assert.throws(() => reconcileDurableCues([newer], [prior]),
    { code: 'local_cue_checkpoint_ahead' });
  assert.throws(() => reconcileDurableCues([prior], [cue({ sourceText: 'different' })]),
    { code: 'subtitle_cue_conflict' });
});

test('proven translation correction keeps Source unchanged', () => {
  const prior = cue();
  const corrected = cue({ revision: 2, translationVersion: 2,
    translatedText: 'corrected translation', providerEventSequence: 2 });
  assert.equal(mergeFinalCue([prior], corrected).cue.sourceText, prior.sourceText);
  assert.equal(mergeFinalCue([prior], corrected).cue.translatedText, 'corrected translation');
  assert.throws(() => mergeFinalCue([prior], { ...corrected, audioTurnId: 'other-turn' }),
    { code: 'subtitle_cue_conflict' });
});
