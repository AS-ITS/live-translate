import assert from 'node:assert/strict';
import test from 'node:test';
import { configureLivePipelineTrace, createLivePipelineTrace, livePipelineTrace } from '../../src/lib/livePipelineTrace.js';
import { createPublicRuntimeConfig } from '../../server/publicRuntimeConfig.js';
import { normalizeGeminiLiveCueEvents } from '../../src/lib/geminiLiveCueEvent.js';
import { LiveTranslateSession } from '../../src/lib/liveSession.js';

test('canonical transitions preserve identity and machine-readable reasons', () => {
  const trace = createLivePipelineTrace({ enabled: true, logger: () => {} });
  const identity = {
    recordingId: 'recording-1', segmentId: 'segment-1', captureEpoch: 2, providerEpoch: 3,
    connectionEpoch: 4, audioTurnId: 'audio-turn-1', providerEventId: 'provider-event-1',
    normalizedEventId: 'normalized-event-1', providerTurnId: 'provider-turn-1', turnKey: 'turn-key-1', cueId: 'cue-1'
  };
  for (const stage of ['MIC_INPUT', 'PCM_CAPTURED', 'PCM_SENT', 'PROVIDER_EVENT']) trace.record({ ...identity, stage });
  trace.record({ ...identity, stage: 'TRANSCRIPT_NORMALIZED', sourceStatus: 'partial', turnState: 'active' });
  trace.record({ ...identity, stage: 'TURN_ASSIGNED', reason: 'provider_turn_identity' });
  trace.record({ ...identity, stage: 'EVENT_DEDUPED', reason: 'duplicate_event' });
  trace.record({ ...identity, stage: 'EVENT_DROPPED', dropReason: 'stale_callback_generation' });
  for (const stage of ['CUE_CREATED', 'CUE_UPDATED', 'CUE_FINALIZED', 'CUE_PUBLISHED', 'VIEWER_RECEIVED', 'REACT_RENDER']) trace.record({ ...identity, stage });
  assert.deepEqual(trace.get().map((entry) => entry.stage), [
    'MIC_INPUT', 'PCM_CAPTURED', 'PCM_SENT', 'PROVIDER_EVENT', 'TRANSCRIPT_NORMALIZED', 'TURN_ASSIGNED',
    'EVENT_DEDUPED', 'EVENT_DROPPED', 'CUE_CREATED', 'CUE_UPDATED', 'CUE_FINALIZED', 'CUE_PUBLISHED', 'VIEWER_RECEIVED', 'REACT_RENDER'
  ]);
  const entries = trace.get();
  assert.equal(entries[4].providerEventId, 'provider-event-1');
  assert.equal(entries[4].normalizedEventId, 'normalized-event-1');
  assert.equal(entries[6].reason, 'duplicate_event');
  assert.equal(entries[7].dropReason, 'stale_callback_generation');
});

test('trace memory is bounded, disabled mode is empty, and production defaults false', () => {
  const trace = createLivePipelineTrace({ enabled: true, limit: 100000, logger: () => {} });
  for (let index = 0; index < 20001; index += 1) trace.record({ stage: 'PCM_CAPTURED', pcmSequence: index });
  assert.equal(trace.get().length, 20000);
  trace.setEnabled(false);
  assert.deepEqual(trace.get(), []);
  assert.equal(trace.record({ stage: 'PCM_SENT' }), null);
  assert.deepEqual(createPublicRuntimeConfig({}), { livePipelineTraceEnabled: false });
});

test('provider event identity remains distinct through normalized and cue trace fields', () => {
  const [event] = normalizeGeminiLiveCueEvents(
    { eventId: 'provider-event-7', serverContent: { inputTranscription: { text: 'hello' } } },
    { sessionId: 'recording-1', segmentId: 'segment-1', connectionEpoch: 2, providerEpoch: 3, audioTurnId: 'audio-turn-1' }
  );
  assert.equal(event.providerEventId, 'provider-event-7');
  assert.notEqual(event.providerEventId, event.eventId);
  const trace = createLivePipelineTrace({ enabled: true, logger: () => {} });
  const entry = trace.record({ stage: 'CUE_CREATED', providerEventId: event.providerEventId, normalizedEventId: event.eventId, cueId: 'cue-1' });
  assert.equal(entry.providerEventId, 'provider-event-7');
  assert.equal(entry.normalizedEventId, event.eventId);
});

test('provider identity stays null when only normalized event identity exists', () => {
  const trace = createLivePipelineTrace({ enabled: true, logger: () => {} });
  const entry = trace.record({ stage: 'TRANSCRIPT_NORMALIZED', eventId: 'normalized-only' });
  assert.equal(entry.providerEventId, null);
  assert.equal(entry.normalizedEventId, 'normalized-only');
});

test('turn completion boundary emits TURN_COMPLETED without changing session semantics', () => {
  configureLivePipelineTrace(true);
  livePipelineTrace.clear();
  try {
    const session = new LiveTranslateSession({ targetLanguageCode: 'en', sessionId: 'recording-1', segmentId: 'segment-1', connectionEpoch: 0 });
    session.handleMessage({ eventId: 'provider-event-8', serverContent: { turnComplete: true } }, 0);
    const completed = livePipelineTrace.get({ stage: 'TURN_COMPLETED' });
    assert.equal(completed.length, 1);
    assert.equal(completed[0].providerEventId, 'provider-event-8');
    assert.equal(completed[0].turnComplete, true);
    assert.equal(completed[0].turnState, 'complete');
  } finally {
    configureLivePipelineTrace(false);
  }
});
