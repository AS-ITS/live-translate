import assert from 'node:assert/strict';
import test from 'node:test';
import { LiveTranslateSession } from '../../src/lib/liveSession.js';
import { applyCueMutation } from '../../src/domain/subtitleCue/cueMutation.js';
import { cueRefinementInputHash } from '../../src/lib/cueContent.js';

test('Cue 52 terminal source replay keeps callback identity for Source V2 to V3', () => {
  const events = [];
  const session = new LiveTranslateSession({
    sessionId: 'session-41', segmentId: 'segment-3',
    sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en',
    onCueEvent: (event) => events.push(event)
  });
  session.connectionEpoch = 9;
  session.providerEpoch = 1;
  session.audioTurnId = 'audio-turn-9-44';
  session.eventSequence = 1356;
  session.handleMessage({ eventId: 'source-1357', serverContent: {
    inputTranscription: { text: '來源初稿' }, outputTranscription: { text: 'initial translation' }
  } });
  const firstSource = events.find((event) => event.stream === 'source');
  const firstTranslation = events.find((event) => event.stream === 'translation');
  assert.equal(firstSource.eventSequence, 1357);
  assert.equal(firstTranslation.eventSequence, 1357);
  session.flushPendingTranscript('input', { localFinalize: true });
  const replay = events.at(-1);
  assert.equal(replay.stream, 'source');
  assert.equal(replay.originEventId, 'source-1357');
  assert.equal(replay.connectionEpoch, 9);
  assert.equal(replay.providerEpoch, 1);
  assert.equal(replay.eventSequence, 1357);

  const provenance = (event) => ({ audioTurnId: 'audio-turn-9-44',
    turnKey: 'local:audio-turn-9-44', connectionEpoch: event.connectionEpoch,
    providerEpoch: event.providerEpoch, eventSequence: event.eventSequence,
    providerEventId: event.providerEventId, eventId: event.eventId });
  const current = {
    cueId: 'cue:session-41:segment-3:52', sessionId: 'session-41',
    segmentId: 'segment-3', sequence: 52, startTimeMs: 0, endTimeMs: 100,
    sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en',
    status: 'final', finalizedReason: 'turnComplete', revision: 1,
    sourceText: '來源初稿', rawSource: '來源初稿', sourceVersion: 2,
    sourceStatus: 'finalized', sourceProvenance: provenance(replay),
    translatedText: 'initial translation', rawTranslation: 'initial translation',
    initialTranslation: 'initial translation', translationVersion: 2,
    translationStatus: 'finalized', translationProvenance: provenance(firstTranslation),
    audioTurnId: 'audio-turn-9-44', turnKey: 'local:audio-turn-9-44',
    connectionEpoch: 9, providerEpoch: 1, providerEventSequence: 1357
  };
  current.refinement = { status: 'pending', version: 1,
    inputHash: cueRefinementInputHash(current) };
  session.eventSequence = 1363;
  session.handleMessage({ eventId: 'source-1364', serverContent: {
    inputTranscription: { text: '來源修正版' }
  } });
  const newerSource = events.at(-1);
  assert.equal(newerSource.eventSequence, 1364);
  const incoming = { ...current, sourceText: '來源修正版', rawSource: '來源修正版',
    sourceVersion: 3, revision: 5, sourceProvenance: provenance(newerSource),
    providerEventSequence: 1364 };
  const result = applyCueMutation(current, { side: 'source', cue: incoming });
  assert.equal(result.status, 'committed', JSON.stringify(result));
  assert.equal(result.cue.sourceVersion, 3);
  assert.equal(result.cue.translationVersion, 2);
  assert.equal(result.cue.refinement.inputHash, cueRefinementInputHash(result.cue));

  // The saved Cue in the incident had a terminal Source V2 without side proof.
  const legacy = { ...current, sourceProvenance: {
    ...current.sourceProvenance, providerEpoch: null, eventSequence: null
  } };
  legacy.refinement = { ...legacy.refinement, inputHash: cueRefinementInputHash(legacy) };
  const rejectedSource = applyCueMutation(legacy, { side: 'source', cue: incoming });
  assert.equal(rejectedSource.reason, 'cue_source_event_unproven');
  assert.equal(rejectedSource.versionState.currentSideProviderEpoch, null);
  assert.equal(rejectedSource.versionState.currentSideSequence, null);
  const translation = { ...incoming, translatedText: 'updated translation',
    rawTranslation: 'updated translation', initialTranslation: 'updated translation',
    translationVersion: 3, translationProvenance: {
      ...current.translationProvenance, providerEventId: 'translation-1365',
      eventId: 'translation-1365', eventSequence: 1365
    }, providerEventSequence: 1365 };
  translation.refinement = { status: 'pending', version: 1,
    inputHash: cueRefinementInputHash(translation) };
  const committedTranslation = applyCueMutation(legacy, { side: 'translation', cue: translation });
  assert.equal(committedTranslation.status, 'committed');
  assert.equal(committedTranslation.cue.sourceVersion, 2);
  assert.equal(committedTranslation.cue.rawSource, legacy.rawSource);
  assert.notEqual(committedTranslation.cue.refinement.inputHash, translation.refinement.inputHash);
  assert.equal(applyCueMutation(committedTranslation.cue,
    { side: 'refinement', cue: translation }).reason, 'cue_refinement_input_conflict');
});

test('terminal replay retains pending callback epoch across reconnect', () => {
  const events = [];
  const session = new LiveTranslateSession({ sessionId: 'session-41',
    segmentId: 'segment-3', targetLanguageCode: 'en',
    onCueEvent: (event) => events.push(event) });
  session.connectionEpoch = 9;
  session.providerEpoch = 1;
  session.audioTurnId = 'audio-turn-9-44';
  session.eventSequence = 1356;
  session.handleMessage({ eventId: 'source-1357', serverContent: {
    inputTranscription: { text: '來源初稿' },
    outputTranscription: { text: 'initial translation' }
  } });
  session.connectionEpoch = 10;
  session.providerEpoch = 2;
  session.flushPendingTranscript('input', { localFinalize: true });
  const replay = events.at(-1);
  assert.equal(replay.originEventId, 'source-1357');
  assert.equal(replay.connectionEpoch, 9);
  assert.equal(replay.providerEpoch, 1);
  assert.equal(replay.eventSequence, 1357);
  session.flushPendingTranscript('output', { localFinalize: true });
  const outputReplay = events.at(-1);
  assert.equal(outputReplay.stream, 'translation');
  assert.equal(outputReplay.connectionEpoch, 9);
  assert.equal(outputReplay.providerEpoch, 1);
  assert.equal(outputReplay.eventSequence, 1357);
});

test('interim Source replay carries its callback proof and never invents missing sequence', () => {
  const events = [];
  const session = new LiveTranslateSession({ sessionId: 'session-41',
    segmentId: 'segment-3', targetLanguageCode: 'en',
    onCueEvent: (event) => events.push(event) });
  session.connectionEpoch = 9;
  session.providerEpoch = 1;
  session.eventSequence = 1356;
  session.handleMessage({ eventId: 'interim-1357', serverContent: {
    interimInputTranscription: { text: '來源暫稿' }
  } });
  session.flushPendingTranscript('input');
  assert.equal(events.at(-1).providerEpoch, 1);
  assert.equal(events.at(-1).eventSequence, 1357);

  session.pendingInputTranscript = { text: 'legacy pending',
    eventId: 'legacy-input', audioTurnId: 'audio-turn-9-44' };
  session.flushPendingTranscript('input');
  assert.equal(events.at(-1).originEventId, 'legacy-input');
  assert.equal(events.at(-1).eventSequence, undefined);
  assert.equal(events.at(-1).providerEpoch, undefined);
});
