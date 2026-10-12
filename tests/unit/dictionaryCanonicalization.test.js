import assert from 'node:assert/strict';
import test from 'node:test';
import { effectiveTranslationForCue } from '../../src/lib/cueContent.js';
import { applyGlossaryCorrectionToCue } from '../../src/lib/glossaryReplacement.js';
import { LiveTranslateSession } from '../../src/lib/liveSession.js';
import { mergeMeetingViewerSnapshot } from '../../src/lib/meetingViewerState.js';
import { applySubtitleCueEvent, createSubtitleCueState } from '../../src/lib/subtitleCues.js';
import { exportCuesToSrt, exportCuesToTxt, exportCuesToVtt } from '../../src/lib/subtitleCueExport.js';
import { createReplayRequest, createSubtitleSource } from '../../src/webrtc/subtitleDataChannel.js';

test('Live partial and final callbacks canonicalize an exact dictionary hit once', () => {
  const outputEvents = [];
  const cueEvents = [];
  const session = new LiveTranslateSession({
    targetLanguageCode: 'en',
    echoTargetLanguage: true,
    liveGlossaryEntries: [{ source: '你好', target: 'su3cl3', replacementAliases: ['Hello'] }],
    onOutputTranscript: (event) => outputEvents.push(event),
    onCueEvent: (event) => cueEvents.push(event)
  });

  session.handleMessage({
    serverContent: {
      interimInputTranscription: { text: '你好' },
      outputTranscription: { text: 'Hello. su3cl3.' }
    }
  });
  session.handleMessage({
    serverContent: {
      inputTranscription: { text: '你好' },
      outputTranscription: { text: 'su3cl3. su3cl3.' },
      turnComplete: true
    }
  });

  assert.deepEqual(
    outputEvents.map(({ text, isFinal }) => ({ text, isFinal })),
    [
      { text: 'su3cl3.', isFinal: false },
      { text: 'su3cl3.', isFinal: true }
    ]
  );
  assert.deepEqual(
    cueEvents.filter((event) => event.stream === 'translation').map(({ text, isFinal }) => ({ text, isFinal })),
    [
      { text: 'su3cl3.', isFinal: false },
      { text: 'su3cl3.', isFinal: true }
    ]
  );
  assert.deepEqual(
    cueEvents.filter((event) => event.stream === 'translation').map((event) => event.providerRawText),
    ['Hello. su3cl3.', 'su3cl3. su3cl3.']
  );
});

test('Live token response dictionary is retained for canonical transcript correction', async () => {
  const originalFetch = globalThis.fetch;
  const outputEvents = [];
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        token: 'mock-token',
        expiresAt: '2099-01-01T00:00:00.000Z',
        liveConnectModel: 'mock-live-model',
        liveConnectConfig: {},
        liveGlossaryEntries: [{ source: '你好', target: 'su3cl3', replacementAliases: ['Hello'] }]
      };
    }
  });

  try {
    const session = new LiveTranslateSession({
      targetLanguageCode: 'en',
      echoTargetLanguage: true,
      onOutputTranscript: (event) => outputEvents.push(event)
    });
    await session.getTokenResponse();
    session.handleMessage({
      serverContent: {
        inputTranscription: { text: '你好' },
        outputTranscription: { text: 'Hello. su3cl3.' },
        turnComplete: true
      }
    });

    assert.equal(session.liveGlossaryEntries.length, 1);
    assert.equal(outputEvents[0].text, 'su3cl3.');
    assert.equal(outputEvents[0].rawText, 'Hello. su3cl3.');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Cue state keeps immutable provider raw translation separate from corrected text', () => {
  let state = createSubtitleCueState();
  const common = {
    sessionId: 'session-raw-1',
    segmentId: 'segment-raw-1',
    audioTurnId: 'audio-turn-raw-1',
    turnKey: 'local:audio-turn-raw-1',
    sourceLanguageCode: 'zh-Hant',
    targetLanguageCode: 'en'
  };
  state = applySubtitleCueEvent(state, {
    ...common,
    eventId: 'source-raw-1',
    stream: 'source',
    text: '你好你好',
    sessionTimeMs: 100,
    isFinal: false
  });
  state = applySubtitleCueEvent(state, {
    ...common,
    eventId: 'translation-raw-1',
    stream: 'translation',
    text: 'su3cl3, su3cl3.',
    providerRawText: 'Hello, hello.',
    glossaryCorrectionStatus: 'corrected',
    sessionTimeMs: 120,
    isFinal: false
  });

  assert.equal(state.currentCue.translatedText, 'su3cl3, su3cl3.');
  assert.equal(state.currentCue.initialTranslation, 'su3cl3, su3cl3.');
  assert.equal(state.currentCue.rawTranslation, 'Hello, hello.');
  assert.equal(state.currentCue.glossaryCorrectionStatus, 'corrected');
});

test('canonical dictionary translation survives cue update, snapshot, replay, Viewer, and export', () => {
  const glossary = [{ source: '你好', target: 'su3cl3', replacementAliases: ['Hello'] }];
  const source = createSubtitleSource({ meetingId: 'meeting-1', sourceId: 'recorder-1' });
  const baseCue = {
    cueId: 'cue-1',
    meetingId: 'meeting-1',
    sequence: 1,
    revision: 1,
    sourceVersion: 1,
    translationVersion: 1,
    startTimeMs: 0,
    endTimeMs: 1_000,
    sourceLanguageCode: 'zh-Hant',
    targetLanguageCode: 'en',
    rawSource: '你好',
    sourceText: '你好',
    rawTranslation: 'Hello. su3cl3.',
    translatedText: 'Hello. su3cl3.',
    status: 'final'
  };

  const appendedCue = applyGlossaryCorrectionToCue(baseCue, glossary);
  const appended = source.append(appendedCue);
  const updatedCue = applyGlossaryCorrectionToCue({
    ...baseCue,
    revision: 2,
    translationVersion: 2,
    refinedTranslation: 'su3cl3. su3cl3.'
  }, glossary);
  const updated = source.update(updatedCue);

  assert.equal(appended.cue.cueId, 'cue-1');
  assert.equal(updated.cue.cueId, 'cue-1');
  assert.equal(effectiveTranslationForCue(updated.cue), 'su3cl3.');

  const snapshot = source.snapshot();
  const replay = source.replay(createReplayRequest({
    meetingId: 'meeting-1',
    requestId: 'replay-1',
    sourceId: 'recorder-1',
    afterSequence: 0
  }));
  const viewer = mergeMeetingViewerSnapshot(null, snapshot);
  const canonicalCue = viewer.cues[0];

  assert.equal(snapshot.cues.length, 1);
  assert.equal(replay.events.length, 2);
  assert.ok(replay.events.every((event) => effectiveTranslationForCue(event.cue) === 'su3cl3.'));
  assert.equal(effectiveTranslationForCue(canonicalCue), 'su3cl3.');

  for (const exported of [
    exportCuesToTxt([canonicalCue], { stream: 'translation' }),
    exportCuesToSrt([canonicalCue], { stream: 'translation' }),
    exportCuesToVtt([canonicalCue], { stream: 'translation' })
  ]) {
    assert.match(exported, /su3cl3/u);
    assert.doesNotMatch(exported, /Hello/u);
    assert.equal(exported.match(/su3cl3/gu)?.length, 1);
  }
});
