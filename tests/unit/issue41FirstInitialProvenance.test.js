import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeGeminiLiveCueEvents } from '../../src/lib/geminiLiveCueEvent.js';
import { applySubtitleCueEvent, createSubtitleCueState, finalizePendingSubtitleCue } from '../../src/lib/subtitleCues.js';
import { applyCueMutation } from '../../src/domain/subtitleCue/cueMutation.js';
import { firstInitialProvenanceMetadata } from '../../src/lib/firstInitialProvenanceTrace.js';
import { LiveTranslateSession } from '../../src/lib/liveSession.js';

test('first Initial trace preserves local provenance and excludes transcript text', () => {
  const message = { serverContent: { inputTranscription: { text: 'private source' },
    outputTranscription: { text: 'private translation' } } };
  const context = { sessionId: 'session-1', segmentId: 'segment-1', connectionEpoch: 2,
    providerEpoch: 3, eventSequence: 4, translationAudioTurnId: 'turn-1',
    sourceAudioTurnId: 'turn-1', sourceTurnKey: 'local:turn-1',
    translationTurnKey: 'local:turn-1', sourceLanguageCode: 'zh-Hant',
    targetLanguageCode: 'en', sessionTimeMs: 100 };
  const [source, event] = normalizeGeminiLiveCueEvents(message, context);
  const state = applySubtitleCueEvent(applySubtitleCueEvent(createSubtitleCueState(), source), event);
  const final = finalizePendingSubtitleCue(state, { sessionTimeMs: 200, force: true }).finalCues[0];
  assert.ok(final);
  const fields = (stage, value) => firstInitialProvenanceMetadata(stage, value);
  const provider = fields('provider', { ...context });
  const normalized = fields('normalized', { ...event, turnId: event.audioTurnId });
  const allocator = fields('allocator', { ...final.translationProvenance, cueId: final.cueId,
    turnId: final.translationProvenance.audioTurnId, previousTranslationVersion: 0,
    translationVersion: final.translationVersion });
  const precommit = fields('before_initial_commit', { ...final.translationProvenance,
    cueId: final.cueId, turnId: final.translationProvenance.audioTurnId,
    previousTranslationVersion: 0, translationVersion: final.translationVersion });
  assert.equal(provider.providerEventIdPresent, false);
  assert.equal(provider.providerEventSequencePresent, false);
  assert.equal(provider.epochSequenceOrigin, 'local_session');
  assert.equal(normalized.providerEventIdPresent, false);
  assert.equal(normalized.turnIdValid, true);
  assert.equal(allocator.cueId, final.cueId);
  assert.equal(precommit.cueId, final.cueId);
  assert.equal(allocator.eventIdentity, provider.eventIdentity);
  assert.equal(precommit.eventIdentity, normalized.eventIdentity);
  assert.equal(precommit.translationVersionIncreased, true);
  assert.equal(JSON.stringify([provider, normalized, allocator, precommit]).includes('private'), false);
  assert.equal(applyCueMutation(null, { side: 'initial', cue: final }).status, 'committed');
});

test('first Initial authority accepts missing side evidence but trace identifies the gap', () => {
  const [source, event] = normalizeGeminiLiveCueEvents(
    { serverContent: { inputTranscription: { text: 'source' }, outputTranscription: { text: 'fixture' } } },
    { sessionId: 'session-1', segmentId: 'segment-1', translationAudioTurnId: 'turn-1',
      sourceAudioTurnId: 'turn-1',
      sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en', sessionTimeMs: 100 }
  );
  const final = finalizePendingSubtitleCue(applySubtitleCueEvent(
    applySubtitleCueEvent(createSubtitleCueState(), source), event),
    { sessionTimeMs: 200, force: true }).finalCues[0];
  const trace = firstInitialProvenanceMetadata('before_initial_commit', {
    ...final.translationProvenance, cueId: final.cueId,
    turnId: final.translationProvenance.audioTurnId,
    previousTranslationVersion: 0, translationVersion: final.translationVersion
  });
  assert.equal(trace.connectionEpochValid, false);
  assert.equal(trace.providerEpochValid, false);
  assert.equal(trace.eventSequenceValid, false);
  assert.equal(trace.translationVersionIncreased, true);
  assert.equal(applyCueMutation(null, { side: 'initial', cue: final }).status, 'committed');
});

test('pending output terminal replay keeps first Initial translation authority through update and reload', () => {
  const events = [];
  const session = new LiveTranslateSession({
    liveSessionId: 'live-replay', sessionId: 'session-replay', segmentId: 'segment-replay',
    sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en', sessionClock: () => 100,
    onCueEvent: (event) => events.push(event)
  });
  session.handleMessage({ serverContent: { inputTranscription: { text: '來源' } } });
  session.handleMessage({ serverContent: { outputTranscription: { text: 'First' } } });
  const original = events.find((event) => event.stream === 'translation');
  session.localFinalizePendingTranscripts();
  const replay = events.find((event) => event.stream === 'translation' && event.isTerminalReplay);
  assert.ok(replay);
  assert.equal(replay.providerEpoch, original.providerEpoch);
  assert.equal(replay.eventSequence, original.eventSequence);

  let state = createSubtitleCueState();
  for (const event of events) state = applySubtitleCueEvent(state, event);
  const initial = finalizePendingSubtitleCue(state, { sessionTimeMs: 200, force: true }).finalCues[0];
  assert.ok(initial);
  assert.equal(initial.translationProvenance.providerEpoch, original.providerEpoch);
  assert.equal(initial.translationProvenance.eventSequence, original.eventSequence);
  const committed = applyCueMutation(null, { side: 'initial', cue: initial });
  assert.equal(committed.status, 'committed');

  const reloaded = structuredClone(committed.cue);
  assert.deepEqual(reloaded.translationProvenance, committed.cue.translationProvenance);
  const updated = applyCueMutation(reloaded, { side: 'translation', cue: {
    ...reloaded, translatedText: 'Second', rawTranslation: 'Second', initialTranslation: 'Second',
    translationVersion: reloaded.translationVersion + 1,
    translationProvenance: { ...reloaded.translationProvenance,
      eventSequence: reloaded.translationProvenance.eventSequence + 1 }
  } });
  assert.equal(updated.status, 'committed');
  session.cleanup();
});
