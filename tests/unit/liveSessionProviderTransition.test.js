import assert from 'node:assert/strict';
import test from 'node:test';
import { LiveTranslateSession } from '../../src/lib/liveSession.js';

test('provider transition drains on semantic boundary while preserving captured PCM', async () => {
  const sent = [];
  const captured = [];
  const cueEvents = [];
  const session = new LiveTranslateSession({
    targetLanguageCode: 'en',
    segmentId: 'segment-1',
    liveSessionId: 'live-1',
    onInputAudioChunk: (bytes) => captured.push([...bytes]),
    onCueEvent: (event) => cueEvents.push(event)
  });
  session.session = { sendRealtimeInput: (payload) => sent.push(payload) };
  session.providerReady = true;
  session.inputSendingEnabled = true;
  session.chunker = { flush: () => [] };

  const draining = session.beginProviderTransition({ maxWaitMs: 100, quietPeriodMs: 0, pollIntervalMs: 1 });
  session.sendInputAudioChunk(new Uint8Array([1, 2]), session.connectionEpoch, { force: true });
  assert.equal(captured.length, 1);
  assert.equal(session.pendingInputAudioChunks.length, 1);

  session.handleMessage({
    eventId: 'boundary-1',
    serverContent: { inputTranscription: { text: 'accepted before rollover' }, turnComplete: true }
  }, session.providerEpoch);
  const result = await draining;
  assert.equal(result.boundaryObserved, true);
  assert.equal(result.segmentId, 'segment-1');
  assert.equal(result.timedOut, false);
  assert.ok(cueEvents.length >= 1);
  assert.ok(cueEvents.every((event) => event.segmentId === 'segment-1'));
  assert.equal(new Set(cueEvents.map((event) => event.eventId)).size, cueEvents.length);
  assert.ok(sent.some((payload) => payload.audioStreamEnd === true));
});

test('failed pre-commit transition resumes the old provider and drains queued PCM once', async () => {
  const sent = [];
  const session = new LiveTranslateSession({ targetLanguageCode: 'en' });
  session.session = { sendRealtimeInput: (payload) => sent.push(payload) };
  session.providerReady = true;
  session.inputSendingEnabled = false;
  session.preRollDraining = true;
  session.queuePendingInputAudioChunk(new Uint8Array([7, 8]));

  assert.equal(session.cancelProviderTransition(), true);
  assert.equal(session.pendingInputAudioChunks.length, 0);
  assert.equal(sent.filter((payload) => payload.audio?.data).length, 1);
});

test('bounded PCM overflow is explicit and never replays dropped history', () => {
  const overflows = [];
  const session = new LiveTranslateSession({
    targetLanguageCode: 'en',
    maxPendingInputAudioBytes: 3,
    maxPendingInputAudioChunks: 2,
    onInputBufferOverflow: (diagnostic) => overflows.push(diagnostic)
  });
  session.queuePendingInputAudioChunk(new Uint8Array([1, 2]));
  session.queuePendingInputAudioChunk(new Uint8Array([3, 4]));

  assert.equal(overflows.length, 1);
  assert.equal(overflows[0].code, 'provider_input_buffer_overflow');
  assert.equal(session.pendingInputAudioChunks.length, 1);
  assert.deepEqual([...session.pendingInputAudioChunks[0].bytes], [3, 4]);
});
