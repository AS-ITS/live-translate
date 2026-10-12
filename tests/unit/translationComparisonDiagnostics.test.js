import assert from 'node:assert/strict';
import test from 'node:test';

import {
  analyzeTranslationRevision,
  createTranslationComparisonDiagnostics
} from '../../src/lib/translationComparisonDiagnostics.js';
import {
  applySubtitleCueEvent,
  createSubtitleCueState,
  finalizePendingSubtitleCue
} from '../../src/lib/subtitleCues.js';

test('translation comparison diagnostics are opt-in, bounded, expiring, exportable, and clear on disable', () => {
  let nowMs = 1_000;
  const diagnostics = createTranslationComparisonDiagnostics({
    allowed: true,
    limit: 2,
    retentionMs: 1_000,
    now: () => nowMs
  });

  assert.equal(diagnostics.get().length, 0);
  assert.equal(diagnostics.record({ eventIdentity: 'disabled-event' }), null);
  assert.equal(diagnostics.enable(), true);

  diagnostics.record({
    stage: 'provider_normalized',
    eventIdentity: 'event-1',
    meetingId: 'meeting-1',
    providerRawSource: '你好你好',
    providerRawTranslation: 'Hello, hello.',
    normalizedTranslation: 'Hello, hello.',
    glossaryCorrectedTranslation: 'su3cl3, su3cl3.',
    token: 'must-not-be-recorded'
  });
  diagnostics.record({
    stage: 'cue_canonical',
    eventIdentity: 'event-1',
    cueId: 'cue-1',
    sourceVersion: 1,
    translationVersion: 2,
    previousCanonicalTranslation: 'Hello, hello.',
    canonicalTranslation: 'Hello.'
  });
  diagnostics.record({ stage: 'provider_normalized', eventIdentity: 'event-2' });
  diagnostics.record({ stage: 'provider_normalized', eventIdentity: 'event-3' });

  const records = diagnostics.get();
  assert.deepEqual(records.map((record) => record.eventIdentity), ['event-2', 'event-3']);
  assert.equal(JSON.stringify(records).includes('must-not-be-recorded'), false);

  diagnostics.clear();
  diagnostics.record({
    stage: 'provider_normalized',
    eventIdentity: 'event-export',
    providerRawTranslation: 'Hello, hello.'
  });
  diagnostics.record({
    stage: 'cue_canonical',
    eventIdentity: 'event-export',
    previousCanonicalTranslation: 'Hello, hello.',
    canonicalTranslation: 'Hello.'
  });
  const exported = JSON.parse(diagnostics.exportJson());
  assert.equal(exported.schemaVersion, 'translation-comparison/v1');
  assert.equal(exported.records[0].revisionAnalysis.relation, 'shortened');
  assert.deepEqual(exported.records[0].stages, ['provider_normalized', 'cue_canonical']);

  nowMs += 1_001;
  assert.deepEqual(diagnostics.get(), []);
  diagnostics.record({ eventIdentity: 'event-clear' });
  diagnostics.disable();
  assert.equal(diagnostics.isEnabled(), false);
  assert.deepEqual(diagnostics.get(), []);
});

test('revision analysis flags loss without claiming semantic source coverage', () => {
  assert.deepEqual(
    analyzeTranslationRevision({
      previousTranslation: "I'm helping you, and the car is 123.",
      nextTranslation: '123, the car.',
      sourceText: '我正在幫你，而且車子是 123。'
    }),
    {
      relation: 'shortened',
      previousLength: 36,
      nextLength: 13,
      contentShortened: true,
      lostTokens: ["i", 'm', 'helping', 'you', 'and', 'is'],
      lostNumericTokens: [],
      sourceCoverage: 'unverified',
      possibleProviderCorrection: true,
      informationLossRisk: true
    }
  );
});

test('partial final and late-final fixture matrix exposes current merge behavior without changing it', () => {
  const fixtures = [
    {
      id: 'A', partial: 'Hello, hello.', final: 'Hello.', late: false,
      expected: 'Hello.', shorterSnapshotReplacedCanonical: true, versionIncremented: true
    },
    {
      id: 'B', partial: 'Hello.', final: 'Hello, hello.', late: false,
      expected: 'Hello, hello.', shorterSnapshotReplacedCanonical: false, versionIncremented: true
    },
    {
      id: 'C', partial: '123, the car.', final: 'car.', late: true,
      expected: '123, the car.', shorterSnapshotReplacedCanonical: false, versionIncremented: false
    },
    {
      id: 'D', partial: "I'm helping you, and the car is 123.", final: '123, the car.', late: true,
      expected: '123, the car.', shorterSnapshotReplacedCanonical: true, versionIncremented: true
    },
    {
      id: 'E', partial: 'Hello, hello.', final: 'Hello, hello.', late: false,
      expected: 'Hello, hello.', shorterSnapshotReplacedCanonical: false, versionIncremented: true
    }
  ];

  for (const fixture of fixtures) {
    const result = runFixture(fixture);
    assert.equal(result.cue.translatedText, fixture.expected, fixture.id);
    assert.equal(result.providerFinalRaw, fixture.final, fixture.id);
    assert.equal(
      fixture.shorterSnapshotReplacedCanonical,
      result.before !== result.cue.translatedText && fixture.final.length < fixture.partial.length,
      fixture.id
    );
    assert.equal(result.cue.translationVersion > result.beforeVersion, fixture.versionIncremented, fixture.id);
    assert.equal(result.cue.audioTurnId, `audio-turn-${fixture.id}`, fixture.id);
    assert.equal(result.cue.turnKey, `local:audio-turn-${fixture.id}`, fixture.id);
  }
});

function runFixture({ id, partial, final, late }) {
  const common = {
    sessionId: 'session-comparison',
    segmentId: 'segment-comparison',
    sourceLanguageCode: 'zh-Hant',
    targetLanguageCode: 'en',
    audioTurnId: `audio-turn-${id}`,
    turnKey: `local:audio-turn-${id}`,
    turnIdentitySource: 'local'
  };
  let state = createSubtitleCueState();
  state = applySubtitleCueEvent(state, {
    ...common,
    eventId: `${id}-source`,
    eventSequence: 1,
    stream: 'source',
    text: sourceForFixture(id),
    sessionTimeMs: 100
  });
  state = applySubtitleCueEvent(state, {
    ...common,
    eventId: `${id}-partial`,
    eventSequence: 2,
    stream: 'translation',
    text: partial,
    providerRawText: partial,
    sessionTimeMs: 200
  });

  if (late) {
    state = finalizePendingSubtitleCue(state, { sessionTimeMs: 300, reason: 'localSilence' });
  }
  const beforeCue = late ? state.finalCues[0] : state.currentCue;
  const before = beforeCue.translatedText;
  const beforeVersion = beforeCue.translationVersion;
  state = applySubtitleCueEvent(state, {
    ...common,
    eventId: `${id}-final`,
    eventSequence: 3,
    stream: 'translation',
    text: final,
    providerRawText: final,
    textMergeMode: 'snapshot',
    sessionTimeMs: 400,
    isFinal: true,
    isLateTranscript: late
  });
  const cue = late ? state.finalCues[0] : state.currentCue;
  return { before, beforeVersion, cue, providerFinalRaw: final };
}

function sourceForFixture(id) {
  if (id === 'C') return '車子 123。';
  if (id === 'D') return '我正在幫你，而且車子是 123。';
  return '你好你好。';
}
