import assert from 'node:assert/strict';
import test from 'node:test';
import { createLiveToken } from '../../server/tokenService.js';
import { applyGlossaryCorrectionToCue, glossaryCorrectionForSource } from '../../src/lib/glossaryReplacement.js';
import { effectiveTranslationForCue } from '../../src/lib/cueContent.js';
import { mergeMeetingViewerSnapshot, applyMeetingCueEvent } from '../../src/lib/meetingViewerState.js';
import { exportCuesToSrt, exportCuesToTxt, exportCuesToVtt } from '../../src/lib/subtitleCueExport.js';

test('Meeting dictionary reaches provider config and corrected Host, Viewer, replay, and exports', async () => {
  let providerConfig;
  const meeting = {
    id: 'meeting-1', sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en',
    glossaryEntries: [{ source: '你好', target: 'global', replacementAliases: ['Hello'] }],
    privateGlossaryEntries: [{ source: '你好', target: 'su3cl3', replacementAliases: ['Hello'] }]
  };
  const token = await createLiveToken(
    { meetingId: meeting.id, sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en' },
    { client: { authTokens: { async create({ config }) { providerConfig = config; return { name: 'mock-token' }; } } },
      glossary: { async entriesFor() { return []; } },
      meetingRepository: { async getMeeting() { return meeting; } } }
  );
  assert.equal(token.glossaryEntryCount, 1);
  assert.equal(token.liveGlossaryEntries[0].target, 'su3cl3');
  assert.match(providerConfig.liveConnectConstraints.config.systemInstruction.parts[0].text,
    /Source term: 你好\nRequired translation: su3cl3/);

  const providerCue = {
    cueId: 'cue-1', sequence: 1, revision: 1, status: 'final',
    startTimeMs: 0, endTimeMs: 1500,
    rawSource: '餵餵餵，你好你好。', rawTranslation: 'Hey, hey, hey, Hello Hello.',
    sourceText: '餵餵餵，你好你好。', translatedText: 'Hey, hey, hey, Hello Hello.',
    initialTranslation: 'Hey, hey, hey, Hello Hello.',
    translationVersion: 2,
    translationProvenance: {
      audioTurnId: 'turn-1', turnKey: 'turn-1', providerEventId: 'provider-1',
      connectionEpoch: 1, providerEpoch: 1, eventSequence: 2
    }
  };
  const hostCue = applyGlossaryCorrectionToCue(providerCue, token.liveGlossaryEntries);
  assert.equal(effectiveTranslationForCue(hostCue), 'Hey, hey, hey, su3cl3 su3cl3.');
  assert.equal(hostCue.rawTranslation, providerCue.rawTranslation);
  assert.equal(hostCue.translationVersion, providerCue.translationVersion);
  assert.deepEqual(hostCue.translationProvenance, providerCue.translationProvenance);

  const viewerSnapshot = mergeMeetingViewerSnapshot(null, { cues: [hostCue] });
  const viewerReplay = applyMeetingCueEvent(viewerSnapshot,
    { type: 'cue.update', eventId: 1, cue: hostCue });
  assert.equal(effectiveTranslationForCue(viewerReplay.cues[0]), effectiveTranslationForCue(hostCue));
  for (const exportText of [
    exportCuesToTxt([hostCue], { stream: 'translation' }),
    exportCuesToSrt([hostCue], { stream: 'translation' }),
    exportCuesToVtt([hostCue], { stream: 'translation' })
  ]) {
    assert.match(exportText, /Hey, hey, hey, su3cl3 su3cl3\./);
    assert.doesNotMatch(exportText, /Hello/);
  }
});

test('correction diagnostic exposes counts and reason without meeting text', () => {
  let diagnostic;
  const result = glossaryCorrectionForSource(
    { sourceText: '你好你好', translatedText: 'Hello.' },
    [{ source: '你好', target: 'su3cl3', replacementAliases: ['Hello'] }],
    { onDiagnostic(value) { diagnostic = value; } }
  );
  assert.equal(result.status, 'correction_uncertain');
  assert.deepEqual(diagnostic, {
    sourceMatchCount: 2, alignmentCandidateCount: 1,
    correctionStatus: 'correction_uncertain', reasonCode: 'alignment_count_mismatch'
  });
  assert.doesNotMatch(JSON.stringify(diagnostic), /你好|Hello|su3cl3/);
});
