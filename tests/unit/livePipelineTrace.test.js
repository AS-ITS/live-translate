import assert from 'node:assert/strict';
import test from 'node:test';
import {
  configureLivePipelineTrace,
  createLivePipelineTrace,
  livePipelineTrace
} from '../../src/lib/livePipelineTrace.js';
import { exposeLiveTranslateDebug } from '../../src/lib/liveSession.js';

test('development pipeline trace records bounded structured turn entries', () => {
  const logs = [];
  const trace = createLivePipelineTrace({
    enabled: true,
    limit: 2,
    now: () => '2026-10-01T00:00:00.000Z',
    logger: (...args) => logs.push(args)
  });

  trace.record({ stage: 'PCM_CAPTURED', recordingId: 'recording-1', audioTurnId: 'turn-1', pcmSequence: 1, pcmBytes: 320 });
  trace.record({
    stage: 'CUE_UPDATED',
    recordingId: 'recording-1',
    audioTurnId: 'turn-1',
    cueId: 'cue-1',
    cueAction: 'append',
    sourceText: '第一句',
    isLateTranscript: true,
    turnComplete: true,
    providerTurnIndex: 7,
    providerTurnId: 'provider-turn-7',
    turnKey: 'local:turn-1',
    turnIdentitySource: 'local'
  });
  trace.record({ stage: 'EVENT_DROPPED', recordingId: 'recording-1', audioTurnId: 'turn-2', cueAction: 'drop' });

  const entries = trace.get();
  assert.equal(entries.length, 2);
  assert.equal(entries[0].cueId, 'cue-1');
  assert.equal(entries[0].isLateTranscript, true);
  assert.equal(entries[0].turnComplete, true);
  assert.equal(entries[0].providerTurnIndex, 7);
  assert.equal(entries[0].providerTurnId, 'provider-turn-7');
  assert.equal(entries[1].dropReason, 'unspecified_drop');
  assert.equal(trace.getTurn('turn-1').length, 1);
  assert.equal(logs.length, 2);
  trace.clear();
  assert.deepEqual(trace.get(), []);
});

test('trace records text lengths without retaining transcript content and isolates logger failures', () => {
  const trace = createLivePipelineTrace({ enabled: true, logger: () => { throw new Error('sink down'); } });
  const entry = trace.record({ stage: 'TRANSCRIPT_NORMALIZED', sourceText: 'x'.repeat(2000), translationText: 'y'.repeat(2000), reason: 'z'.repeat(2000) });
  assert.equal(entry.sourceTextLength, 2000);
  assert.equal(entry.translationTextLength, 2000);
  assert.equal(Object.hasOwn(entry, 'sourceText'), false);
  assert.equal(Object.hasOwn(entry, 'translationText'), false);
  assert.match(entry.reason, /\.\.\.\[truncated\]$/u);
  assert.doesNotThrow(() => trace.record({ stage: 'CUE_UPDATED', cueId: 'cue-1' }));
});

test('trace derives meeting and provider session elapsed time without changing event ordering', () => {
  let nowMs = 4_663_000;
  const trace = createLivePipelineTrace({
    enabled: true,
    nowMs: () => nowMs,
    getElapsedContext: () => ({ meetingStartedAtMs: 0, sessionStartedAtMs: 4_080_000 }),
    logger: () => {}
  });

  trace.record({ stage: 'SESSION_ROLLOVER_START' });
  nowMs += 2_000;
  trace.record({ stage: 'CHECKPOINT_FAILED' });

  assert.deepEqual(trace.get().map(({ stage, traceSequence, meetingElapsedMs, sessionElapsedMs }) => ({
    stage,
    traceSequence,
    meetingElapsedMs,
    sessionElapsedMs
  })), [
    { stage: 'SESSION_ROLLOVER_START', traceSequence: 1, meetingElapsedMs: 4_663_000, sessionElapsedMs: 583_000 },
    { stage: 'CHECKPOINT_FAILED', traceSequence: 2, meetingElapsedMs: 4_665_000, sessionElapsedMs: 585_000 }
  ]);
});

test('persistence and Viewer transport traces preserve causal state fields', () => {
  const trace = createLivePipelineTrace({ enabled: true, logger: () => {} });
  trace.record({
    stage: 'CLOUD_CUE_SAVE_FAILED',
    meetingId: 'meeting-1',
    sessionId: 'session-1',
    segmentId: 'segment-1',
    cueId: 'cue-58',
    operationId: 'operation-58',
    recorderEpoch: 7,
    providerEpoch: 8,
    transportGeneration: 9,
    reconnectAttempt: 2,
    reconnectReason: 'ice_disconnected',
    signalSequence: 41,
    signalingCursorBefore: 39,
    signalingCursorAfter: 41,
    signalMessageCount: 2,
    participantTtlMs: 60_000,
    messageExpiresAt: 1_760_000_030_000,
    recoveryAttemptState: 'scheduled',
    retryCounterSemantics: 'incremented_when_scheduled',
    lastReceivedCueSequence: 58,
    cueDeliverySource: 'replay',
    connectionState: 'connected',
    iceConnectionState: 'connected',
    dataChannelState: 'open',
    realtimeState: 'connected',
    persistenceState: 'retrying',
    httpStatus: 503,
    errorCode: 'cloud_capability_unavailable'
  });

  assert.deepEqual(trace.get()[0], {
    ...trace.get()[0],
    meetingId: 'meeting-1',
    sessionId: 'session-1',
    segmentId: 'segment-1',
    cueId: 'cue-58',
    operationId: 'operation-58',
    recorderEpoch: 7,
    providerEpoch: 8,
    transportGeneration: 9,
    reconnectAttempt: 2,
    reconnectReason: 'ice_disconnected',
    signalSequence: 41,
    signalingCursorBefore: 39,
    signalingCursorAfter: 41,
    signalMessageCount: 2,
    participantTtlMs: 60_000,
    messageExpiresAt: 1_760_000_030_000,
    recoveryAttemptState: 'scheduled',
    retryCounterSemantics: 'incremented_when_scheduled',
    lastReceivedCueSequence: 58,
    cueDeliverySource: 'replay',
    connectionState: 'connected',
    iceConnectionState: 'connected',
    dataChannelState: 'open',
    realtimeState: 'connected',
    persistenceState: 'retrying',
    httpStatus: 503,
    errorCode: 'cloud_capability_unavailable'
  });
});

test('production-disabled pipeline trace retains and logs nothing', () => {
  const logs = [];
  const trace = createLivePipelineTrace({ enabled: false, logger: (...args) => logs.push(args) });
  assert.equal(trace.record({ stage: 'NORMALIZED', sourceText: 'secret transcript' }), null);
  assert.deepEqual(trace.get(), []);
  assert.deepEqual(logs, []);
  assert.equal(trace.isEnabled(), false);
});

test('runtime opt-in enables trace independently of build mode and disabling discards entries', () => {
  const trace = createLivePipelineTrace({ enabled: false, logger: () => {} });
  trace.setEnabled(true);
  trace.record({ stage: 'PCM_SENT', pcmSequence: 1, pcmBytes: 320 });
  assert.equal(trace.isEnabled(), true);
  assert.equal(trace.get().length, 1);
  trace.setEnabled(false);
  assert.equal(trace.isEnabled(), false);
  assert.deepEqual(trace.get(), []);
});

test('auth and rollover lifecycle traces keep explicit non-secret identities', () => {
  const trace = createLivePipelineTrace({ enabled: true, logger: () => {} });
  trace.record({
    stage: 'AUTH_STATE_CHANGED',
    meetingId: 'meeting-1',
    recordingId: 'recording-1',
    recorderSessionId: 'recorder-session-1',
    geminiSessionId: 'gemini-session-2',
    segmentId: 'segment-2',
    rolloverGeneration: 3,
    authEvent: 'TOKEN_REFRESHED',
    recordingState: 'switching-segment',
    httpStatus: 200,
    errorCode: null,
    reason: 'same-user',
    accessToken: 'must-not-be-recorded'
  });

  const [entry] = trace.get();
  assert.equal(entry.meetingId, 'meeting-1');
  assert.equal(entry.recordingId, 'recording-1');
  assert.equal(entry.recorderSessionId, 'recorder-session-1');
  assert.equal(entry.geminiSessionId, 'gemini-session-2');
  assert.equal(entry.segmentId, 'segment-2');
  assert.equal(entry.rolloverGeneration, 3);
  assert.equal(entry.authEvent, 'TOKEN_REFRESHED');
  assert.equal(entry.recordingState, 'switching-segment');
  assert.equal(entry.reason, 'same-user');
  assert.equal(Object.hasOwn(entry, 'accessToken'), false);
});

test('trace allowlist excludes secrets and PCM audio content', () => {
  const trace = createLivePipelineTrace({ enabled: true, logger: () => {} });
  trace.record({
    stage: 'PCM_SENT',
    pcmSequence: 1,
    pcmBytes: 320,
    transportResult: 'sent',
    apiKey: 'secret-api-key',
    token: 'secret-token',
    Authorization: 'Bearer secret',
    credentials: { password: 'secret' },
    pcmAudioContent: new Uint8Array([1, 2, 3])
  });
  const serialized = JSON.stringify(trace.get());
  assert.equal(serialized.includes('secret-api-key'), false);
  assert.equal(serialized.includes('secret-token'), false);
  assert.equal(serialized.includes('Bearer secret'), false);
  assert.equal(serialized.includes('password'), false);
  assert.equal(serialized.includes('pcmAudioContent'), false);
});

test('PCM trace allowlist preserves numeric continuity fields without payloads or credentials', () => {
  const trace = createLivePipelineTrace({ enabled: true, logger: () => {} });
  trace.record({
    stage: 'PCM_CAPTURED',
    pcmSequence: 7,
    pcmBytes: 320,
    pcmSampleCount: 160,
    pcmDurationMs: 10,
    pcmCaptureTimestampMs: 1234.5,
    payload: 'audio-payload',
    base64: 'encoded-audio',
    token: 'secret-token'
  });
  trace.record({
    stage: 'PCM_SENT',
    pcmSequence: 7,
    pcmBytes: 320,
    pcmSampleCount: 160,
    pcmDurationMs: 10,
    pcmCaptureTimestampMs: 1234.5,
    transportResult: 'sync-return',
    payload: { audio: { data: 'encoded-audio' } },
    Authorization: 'Bearer secret-token'
  });

  const entries = trace.get();
  assert.deepEqual(entries.map((entry) => ({
    stage: entry.stage,
    pcmSampleCount: entry.pcmSampleCount,
    pcmDurationMs: entry.pcmDurationMs,
    pcmCaptureTimestampMs: entry.pcmCaptureTimestampMs
  })), [
    { stage: 'PCM_CAPTURED', pcmSampleCount: 160, pcmDurationMs: 10, pcmCaptureTimestampMs: 1234.5 },
    { stage: 'PCM_SENT', pcmSampleCount: 160, pcmDurationMs: 10, pcmCaptureTimestampMs: 1234.5 }
  ]);
  const serialized = JSON.stringify(entries);
  assert.equal(serialized.includes('audio-payload'), false);
  assert.equal(serialized.includes('encoded-audio'), false);
  assert.equal(serialized.includes('secret-token'), false);
  assert.equal(serialized.includes('Authorization'), false);
});

test('full debug trace API is exposed only while runtime trace is enabled', () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};
  try {
    configureLivePipelineTrace(true);
    exposeLiveTranslateDebug();
    assert.equal(typeof window.__liveTranslateDebug.getPipelineTrace, 'function');
    assert.equal(typeof window.__liveTranslateDebug.getTurnTrace, 'function');
    assert.equal(typeof window.__liveTranslateDebug.clearPipelineTrace, 'function');
    assert.equal(typeof window.__liveTranslateDebug.exportPipelineTrace, 'function');
    assert.equal(typeof window.__liveTranslateDebug.getSnapshot, 'function');

    livePipelineTrace.record({ stage: 'PCM_CAPTURED', audioTurnId: 'turn-debug' });
    assert.equal(window.__liveTranslateDebug.getTurnTrace('turn-debug').length, 1);

    configureLivePipelineTrace(false);
    exposeLiveTranslateDebug();
    assert.equal(window.__liveTranslateDebug.getPipelineTrace, undefined);
    assert.equal(window.__liveTranslateDebug.getTurnTrace, undefined);
    assert.equal(window.__liveTranslateDebug.clearPipelineTrace, undefined);
    assert.equal(window.__liveTranslateDebug.exportPipelineTrace, undefined);
  } finally {
    configureLivePipelineTrace(false);
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test('console trace remains exportable after recovery_failed until explicitly cleared', () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};
  try {
    configureLivePipelineTrace(true);
    exposeLiveTranslateDebug();
    livePipelineTrace.record({
      stage: 'WEBRTC_TRANSPORT_RECOVERY',
      eventType: 'RECOVERY_EXHAUSTED',
      role: 'viewer',
      meetingId: 'meeting-1',
      participantId: 'viewer-1',
      connectionEpoch: 14,
      negotiationId: 'negotiation-6',
      attemptCount: 6,
      recoveryAttemptState: 'exhausted',
      retryCounterSemantics: 'incremented_when_scheduled',
    });

    const exported = JSON.parse(window.__liveTranslateDebug.exportPipelineTrace());
    assert.equal(exported.entries.at(-1).eventType, 'RECOVERY_EXHAUSTED');
    assert.equal(exported.entries.at(-1).attemptCount, 6);
    assert.equal(window.__liveTranslateDebug.getPipelineTrace().length, 1);

    window.__liveTranslateDebug.clearPipelineTrace();
    assert.deepEqual(window.__liveTranslateDebug.getPipelineTrace(), []);
  } finally {
    configureLivePipelineTrace(false);
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test('trace does not infer logical-turn identity from Cue identity', () => {
  const trace = createLivePipelineTrace({ enabled: true, logger: () => {} });
  const entry = trace.record({ stage: 'CUE_CREATED', cueId: 'cue-only' });
  assert.equal(entry.turnKey, null);
  assert.equal(entry.audioTurnId, null);
});

test('trace export preserves bounded sequence and before/after transcript lengths', () => {
  const trace = createLivePipelineTrace({ enabled: true, limit: 2, logger: () => {} });
  trace.record({ stage: 'TRANSCRIPT_NORMALIZED', eventSequence: 7, sourceText: '這一句' });
  trace.record({
    stage: 'CUE_UPDATED',
    cueId: 'cue-1',
    beforeSourceText: '這一句',
    afterSourceText: '這一句不能消失。',
    beforeTranslationText: 'this sentence',
    afterTranslationText: 'this sentence cannot disappear'
  });
  trace.record({ stage: 'EVENT_DROPPED', dropReason: 'duplicate_event' });

  const entries = trace.get();
  assert.deepEqual(entries.map((entry) => entry.traceSequence), [2, 3]);
  assert.equal(entries[0].beforeSourceTextLength, '這一句'.length);
  assert.equal(entries[0].afterSourceTextLength, '這一句不能消失。'.length);
  assert.equal(entries[0].beforeTranslationTextLength, 'this sentence'.length);
  assert.equal(entries[0].afterTranslationTextLength, 'this sentence cannot disappear'.length);

  const exported = JSON.parse(trace.exportJson());
  assert.equal(exported.schemaVersion, 'live-pipeline-trace/v1');
  assert.equal(exported.capacity, 2);
  assert.equal(exported.droppedCount, 1);
  assert.equal(exported.entryCount, 2);
  assert.deepEqual(exported.entries, entries);
  assert.equal(JSON.stringify(exported).includes('undefined'), false);
  assert.equal(JSON.stringify(exported).includes('this sentence'), false);
});

test('trace export includes correlation fields and redacts sensitive free-form values', () => {
  const trace = createLivePipelineTrace({ enabled: true, logger: () => {} });
  trace.record({
    stage: 'WEBRTC_SIGNALING',
    role: 'viewer',
    eventType: 'offer.received',
    meetingId: 'meeting-1',
    connectionEpoch: 4,
    negotiationId: 'negotiation-1',
    reason: 'Bearer secret-token from 192.168.1.20',
    shareToken: 'share-token-must-not-appear',
    shareCode: 'share-code-must-not-appear',
    turnCredential: 'turn-password-must-not-appear',
    sdp: 'v=0 secret-sdp',
    candidate: 'candidate:1 1 UDP 2122260223 192.168.1.20 5000 typ host'
  });

  const exported = JSON.parse(trace.exportJson());
  const [entry] = exported.entries;
  assert.equal(entry.role, 'viewer');
  assert.equal(entry.event, 'WEBRTC_SIGNALING.offer.received');
  assert.equal(entry.meetingId, 'meeting-1');
  assert.equal(entry.generation, 4);
  assert.equal(entry.negotiationId, 'negotiation-1');
  assert.match(entry.reason, /\[redacted\]/u);
  const serialized = JSON.stringify(exported);
  assert.doesNotMatch(serialized, /secret-token|192\.168\.1\.20|share-token-must-not-appear|share-code-must-not-appear|turn-password-must-not-appear|secret-sdp|candidate:1/u);
});

test('trace preserves bounded local terminal replay provenance', () => {
  const trace = createLivePipelineTrace({ enabled: true, logger: () => {} });
  trace.record({
    stage: 'CUE_UPDATED',
    eventId: 'tail:terminal-final',
    originEventId: 'tail',
    providerEventId: 'tail',
    normalizedEventId: 'tail:terminal-final',
    terminalStatus: 'local-final',
    terminalReason: 'local-silence',
    localFinalize: true,
    isTerminalReplay: true,
    sourceText: '消失。'
  });

  const entry = trace.get()[0];
  assert.equal(entry.originEventId, 'tail');
  assert.equal(entry.terminalStatus, 'local-final');
  assert.equal(entry.terminalReason, 'local-silence');
  assert.equal(entry.localFinalize, true);
  assert.equal(entry.isTerminalReplay, true);
});
