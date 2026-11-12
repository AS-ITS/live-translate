import assert from 'node:assert/strict';
import test from 'node:test';
import { GoogleGenAI } from '@google/genai';
import { classifyConnectionFailure } from '../../src/lib/connectionFailures.js';
import { createAudioContext, LiveTranslateSession } from '../../src/lib/liveSession.js';
import { createReconnectController } from '../../src/lib/reconnectController.js';

test('live token setup does not map retired Gemini credential errors to Live UX copy', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 409,
    async json() {
      return { error: { code: 'gemini_credential_not_configured' } };
    }
  });

  try {
    const session = new LiveTranslateSession({ targetLanguageCode: 'en' });
    await assert.rejects(
      session.getTokenResponse(),
      (error) => {
        assert.equal(error.code, 'gemini_credential_not_configured');
        assert.equal(error.status, 409);
        assert.equal(error.message, '無法準備即時翻譯請求。');
        assert.equal(error.userMessage, '無法準備即時翻譯請求。（HTTP 409）');
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('live token origin failure does not collapse into generic authorization copy', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 403,
    async json() {
      return { error: { code: 'invalid_origin' } };
    }
  });

  try {
    const session = new LiveTranslateSession({ targetLanguageCode: 'en' });
    await assert.rejects(session.getTokenResponse(), (error) => {
      assert.equal(error.code, 'invalid_origin');
      assert.equal(error.status, 403);
      assert.equal(error.message, '此網站不允許請求即時翻譯，請檢查前端網址設定。');
      assert.equal(error.userMessage, '此網站不允許請求即時翻譯，請檢查前端網址設定。（HTTP 403）');
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('unexpected close triggers connection failure after cleanup', async () => {
  const events = [];
  const failures = [];
  const session = createTestSession({
    events,
    onConnectionFailure: (failure) => {
      events.push('failure');
      failures.push(failure);
    },
    onError: () => events.push('error')
  });

  await session.handleSessionClose({ reason: 'provider closed', code: 1011 });

  assert.deepEqual(events, ['cleanup', 'failure', 'error']);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].source, 'unexpected_close');
  assert.equal(failures[0].reasonHint, 'unexpected_close');
  assert.equal(failures[0].afterCleanup, true);
  assert.deepEqual(failures[0].rawEvent, { reason: 'provider closed', code: 1011 });
  assert.deepEqual(failures[0].diagnostic, {
    at: failures[0].diagnostic.at,
    source: 'unexpected_close',
    reasonHint: 'unexpected_close',
    code: 1011,
    status: null,
    providerReason: 'provider closed',
    connectionEpoch: 0,
    liveSessionId: failures[0].diagnostic.liveSessionId,
    segmentId: failures[0].diagnostic.segmentId,
    audioCallbackCount: 0,
    audioCallbackGapCount: 0,
    maxAudioCallbackGapMs: 0,
    lastAudioCallbackGapMs: null,
    audioCallbackGapP95Ms: 0,
    captureProcessorMode: 'script',
    captureGraphGeneration: 0,
    activeCaptureGraphGeneration: null,
    audioCaptureStage: 'not_started',
    lastAudioCallbackType: null,
    lastWorkletProcessCount: null,
    audioContextState: null,
    microphoneTrackState: null,
    pcmSendAttemptCount: 0,
    pcmSendSyncThrowCount: 0,
    pcmSendAsyncRejectCount: 0
  });
});

test('failure diagnostics expose provider codes without exposing credentials', async () => {
  const failures = [];
  const session = createTestSession({ onConnectionFailure: (failure) => failures.push(failure) });

  await session.handleSessionClose({
    reason: 'token=secret-token-value',
    code: 1008,
    status: 401
  });

  assert.equal(failures[0].diagnostic.code, 1008);
  assert.equal(failures[0].diagnostic.status, 401);
  assert.equal(failures[0].diagnostic.providerReason, '[redacted]');
  assert.equal(session.getDebugSnapshot().failureDiagnostics.length, 1);
  assert.equal(JSON.stringify(session.getDebugSnapshot()).includes('secret-token-value'), false);
});

test('staging-safe debug snapshots redact pending transcript text', () => {
  const session = new LiveTranslateSession({ targetLanguageCode: 'en' });
  const snapshot = session.getDebugSnapshot({ includeText: false });

  assert.equal(snapshot.pendingInputTranscript, null);
  assert.equal(snapshot.pendingOutputTranscript, null);
});

test('expected user stop does not trigger connection failure', async () => {
  const events = [];
  let failureCount = 0;
  const session = createTestSession({
    events,
    onConnectionFailure: () => {
      failureCount += 1;
    },
    onClose: () => events.push('close')
  });

  await session.stop();

  assert.deepEqual(events, ['cleanup', 'close']);
  assert.equal(failureCount, 0);
});

test('live error triggers connection failure after cleanup', async () => {
  const events = [];
  const failures = [];
  const error = new Error('provider failed');
  const session = createTestSession({
    events,
    onConnectionFailure: (failure) => {
      events.push('failure');
      failures.push(failure);
    },
    onError: () => events.push('error')
  });

  await session.handleSessionError(error);

  assert.deepEqual(events, ['cleanup', 'failure', 'error']);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].source, 'live_error');
  assert.equal(failures[0].reasonHint, 'provider_error');
  assert.equal(failures[0].rawError, error);
  assert.equal(failures[0].rawEvent, error);
  assert.equal(failures[0].afterCleanup, true);
});

test('live error preserves nested provider status, code, and error object', async () => {
  const failures = [];
  const providerError = { status: 403, code: 'auth_failed', message: 'forbidden' };
  const event = { error: providerError, message: 'Live API authorization failed' };
  const session = createTestSession({ onConnectionFailure: (failure) => failures.push(failure) });

  await session.handleSessionError(event);

  assert.equal(failures[0].rawError.status, 403);
  assert.equal(failures[0].rawError.code, 'auth_failed');
  assert.equal(failures[0].rawError.error, providerError);
  assert.equal(failures[0].diagnostic.status, 403);
});

test('connection failure payload includes afterCleanup true', async () => {
  let failurePayload;
  const session = createTestSession({
    onConnectionFailure: (failure) => {
      failurePayload = failure;
    }
  });

  await session.handleSessionClose({ reason: 'closed' });

  assert.equal(failurePayload.afterCleanup, true);
});

test('microphone track ending emits selected-device failure after cleanup', async () => {
  const failures = [];
  const session = createTestSession({ onConnectionFailure: (failure) => failures.push(failure) });
  session.inputDeviceId = 'mic-1';
  const track = { addEventListener: (_event, handler) => { track.handler = handler; }, removeEventListener() {} };
  session.mediaStream = { getTracks: () => [track] };
  session.attachMicrophoneTrackListeners();

  await track.handler();

  assert.equal(failures.length, 1);
  assert.equal(failures[0].source, 'microphone_disconnected');
  assert.equal(failures[0].reasonHint, 'selected_device_missing');
  assert.equal(failures[0].afterCleanup, true);
});

test('selected microphone Invalid constraint falls back to the browser default', async () => {
  const previousMediaDevices = globalThis.navigator?.mediaDevices;
  const calls = [];
  const fallbackStream = { getTracks: () => [] };
  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: async (constraints) => {
        calls.push(constraints);
        if (calls.length === 1) {
          throw new TypeError('Invalid constraint');
        }
        return fallbackStream;
      }
    }
  });

  try {
    const session = new LiveTranslateSession({ targetLanguageCode: 'en', inputDeviceId: 'mic-1' });
    const stream = await session.openInputStream();

    assert.equal(stream, fallbackStream);
    assert.deepEqual(calls, [
      {
        audio: {
          deviceId: { exact: 'mic-1' },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1
        }
      },
      {
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1
        }
      }
    ]);
  } finally {
    if (previousMediaDevices === undefined) {
      delete globalThis.navigator.mediaDevices;
    } else {
      Object.defineProperty(globalThis.navigator, 'mediaDevices', {
        configurable: true,
        value: previousMediaDevices
      });
    }
  }
});

test('startup waits for Gemini setupComplete before proceeding', async () => {
  const session = new LiveTranslateSession({ targetLanguageCode: 'en' });
  session.providerEpoch = 7;
  const waiting = session.waitForSetupComplete(7);
  assert.equal(session.setupCompleteResolver.providerEpoch, 7);
  session.handleMessage({ setupComplete: {} }, 7);
  await waiting;
  assert.equal(session.setupCompletePromise, null);
  assert.equal(session.setupCompleteResolver, null);
});

test('startup rejects an inactive or ended microphone stream with a stage-specific error', async () => {
  const session = new LiveTranslateSession({ targetLanguageCode: 'en' });
  const stream = {
    active: false,
    getTracks: () => [{ readyState: 'ended', enabled: true }]
  };

  await assert.rejects(
    () => session.start({ inputStream: stream }),
    (error) => error.message === '麥克風 track 已失效。' && error.startupStage === 'microphone_stream_invalid'
  );
  assert.equal(session.getDebugSnapshot().startupStage, 'microphone_stream_invalid');
  assert.equal(session.mediaStream, null);
});

test('microphone permission errors do not fall back to the browser default', async () => {
  const previousMediaDevices = globalThis.navigator?.mediaDevices;
  let callCount = 0;
  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: async () => {
        callCount += 1;
        throw new DOMException('Permission denied', 'NotAllowedError');
      }
    }
  });

  try {
    const session = new LiveTranslateSession({ targetLanguageCode: 'en', inputDeviceId: 'mic-1' });
    await assert.rejects(() => session.openInputStream(), { name: 'NotAllowedError' });
    assert.equal(callCount, 1);
  } finally {
    if (previousMediaDevices === undefined) {
      delete globalThis.navigator.mediaDevices;
    } else {
      Object.defineProperty(globalThis.navigator, 'mediaDevices', {
        configurable: true,
        value: previousMediaDevices
      });
    }
  }
});

test('live session uses Safari webkitAudioContext fallback', async () => {
  const previousAudioContext = globalThis.AudioContext;
  const previousWebkitAudioContext = globalThis.webkitAudioContext;
  class SafariAudioContext {
    constructor() {
      this.sampleRate = 16000;
      this.state = 'running';
      this.destination = {};
    }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createScriptProcessor() { return { connect() {}, disconnect() {} }; }
    addEventListener() {}
    removeEventListener() {}
    async close() { this.state = 'closed'; }
  }

  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: undefined });
  Object.defineProperty(globalThis, 'webkitAudioContext', { configurable: true, value: SafariAudioContext });
  try {
    assert.ok(createAudioContext() instanceof SafariAudioContext);
  } finally {
    if (previousAudioContext === undefined) delete globalThis.AudioContext;
    else Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: previousAudioContext });
    if (previousWebkitAudioContext === undefined) delete globalThis.webkitAudioContext;
    else Object.defineProperty(globalThis, 'webkitAudioContext', { configurable: true, value: previousWebkitAudioContext });
  }
});

test('disabled translated audio playback does not enqueue output audio', () => {
  let createBufferCalls = 0;
  const outputChunks = [];
  const session = new LiveTranslateSession({
    targetLanguageCode: 'en',
    echoTargetLanguage: false,
    onOutputAudioChunk: (chunk) => outputChunks.push(chunk)
  });
  session.audioContext = {
    createBuffer() {
      createBufferCalls += 1;
    }
  };

  session.handleMessage({
    serverContent: {
      modelTurn: {
        parts: [{ inlineData: { data: 'AAAA' } }]
      }
    }
  });

  assert.equal(createBufferCalls, 0);
  assert.deepEqual(outputChunks, []);
});

test('offline signal emits a recoverable failure after cleanup', async () => {
  const failures = [];
  const session = createTestSession({ onConnectionFailure: (failure) => failures.push(failure) });

  await session.handleNetworkOffline();

  assert.equal(failures.length, 1);
  assert.equal(failures[0].source, 'network_offline');
  assert.equal(failures[0].reasonHint, 'network_offline');
  assert.equal(failures[0].afterCleanup, true);
});

test('user stop cancels reconnect controller schedule', async () => {
  const timer = createFakeTimer();
  const controller = createReconnectController({ timer });

  await controller.scheduleReconnect(classifyConnectionFailure('unexpected_close'));
  controller.cancel();

  assert.equal(controller.currentState(), 'cancelled');
  assert.equal(timer.pendingCount(), 0);
});

test('duplicate failure signals do not create duplicate pending schedules', async () => {
  const timer = createFakeTimer();
  const controller = createReconnectController({ timer });
  const handleFailure = (failure) => {
    const classification = classifyConnectionFailure({
      reason: failure.reasonHint,
      error: failure.rawError,
      context: failure.source
    });
    return controller.scheduleReconnect(classification);
  };

  const first = await handleFailure({ reasonHint: 'unexpected_close', source: 'unexpected_close' });
  const second = await handleFailure({ reasonHint: 'provider_error', source: 'live_error' });

  assert.equal(first.scheduled, true);
  assert.equal(second.ignored, true);
  assert.equal(timer.pendingCount(), 1);
});

test('GoAway schedules one reconnect and forces a fresh token', async () => {
  const session = createTestSession();
  const previousSetTimeout = globalThis.setTimeout;
  const timers = [];
  globalThis.setTimeout = (callback, delayMs) => {
    const timer = { callback, delayMs };
    timers.push(timer);
    return timer;
  };
  try {
    session.reconnectProvider = async (options) => {
      session.reconnectOptions = options;
      return true;
    };

    session.handleMessage({ goAway: { timeLeft: '2s' }, sessionResumptionUpdate: { newHandle: 'resume-1' } });
    session.handleMessage({ goAway: { timeLeft: '1s' }, sessionResumptionUpdate: { newHandle: 'resume-2' } });

    assert.equal(timers.length, 1);
    assert.equal(timers[0].delayMs, 2000);
    assert.equal(session.resumptionHandle, 'resume-2');
    timers[0].callback();
    await new Promise((resolve) => previousSetTimeout(resolve, 0));
    assert.deepEqual(session.reconnectOptions, { forceRefresh: true });
  } finally {
    globalThis.setTimeout = previousSetTimeout;
  }
});

test('provider reconnect rotates live session id across meeting segments', async () => {
  const session = new LiveTranslateSession({
    liveSessionId: 'live-session-1',
    segmentId: 'segment-1',
    targetLanguageCode: 'en'
  });
  let connectOptions = null;
  const previousAudioTurnId = session.audioTurnId;
  session.connectProvider = async (options) => {
    connectOptions = options;
    return true;
  };

  assert.equal(
    await session.reconnectProvider({
      segmentId: 'segment-2',
      liveSessionId: 'live-session-2',
      forceRefresh: true
    }),
    true
  );
  assert.equal(session.segmentId, 'segment-2');
  assert.equal(session.liveSessionId, 'live-session-2');
  assert.notEqual(session.audioTurnId, previousAudioTurnId);
  assert.deepEqual(connectOptions, { forceRefresh: true });
});

test('transparent provider reconnect preserves the incomplete local audio turn identity', async () => {
  const session = new LiveTranslateSession({
    liveSessionId: 'live-session-1',
    segmentId: 'segment-1',
    targetLanguageCode: 'en'
  });
  const previousAudioTurnId = session.audioTurnId;
  session.connectProvider = async () => true;

  assert.equal(await session.reconnectProvider({ forceRefresh: true }), true);
  assert.equal(session.audioTurnId, previousAudioTurnId);
});

test('turnComplete followed by generationComplete rotates the audio turn only once', () => {
  const sourceEvents = [];
  const session = new LiveTranslateSession({
    targetLanguageCode: 'en',
    onCueEvent: (event) => {
      if (event.stream === 'source') sourceEvents.push(event);
    }
  });

  session.handleMessage({ eventId: 'text-1', serverContent: { inputTranscription: { text: 'first sentence' } } });
  session.handleMessage({ eventId: 'turn-1', serverContent: { turnComplete: true } });
  const nextAudioTurnId = session.audioTurnId;
  session.handleMessage({ eventId: 'generation-1', serverContent: { generationComplete: true } });
  assert.equal(session.audioTurnId, nextAudioTurnId);

  session.handleMessage({ eventId: 'text-2', serverContent: { inputTranscription: { text: 'second sentence' } } });
  assert.equal(sourceEvents.length, 2);
  assert.notEqual(sourceEvents[0].audioTurnId, sourceEvents[1].audioTurnId);
});

test('turn completion finalizes preceding input and output transcript partials', () => {
  const inputEvents = [];
  const outputEvents = [];
  const session = new LiveTranslateSession({
    targetLanguageCode: 'ja',
    echoTargetLanguage: true,
    onInputTranscript: (event) => inputEvents.push(event),
    onOutputTranscript: (event) => outputEvents.push(event)
  });

  session.handleMessage({
    serverContent: {
      inputTranscription: { text: 'first source sentence' },
      outputTranscription: { text: 'first translated sentence' }
    }
  });
  session.handleMessage({ serverContent: { turnComplete: true } });

  assert.deepEqual(inputEvents.map(({ text, isFinal }) => ({ text, isFinal })), [
    { text: 'first source sentence', isFinal: false },
    { text: 'first source sentence', isFinal: true }
  ]);
  assert.deepEqual(outputEvents.map(({ text, isFinal }) => ({ text, isFinal })), [
    { text: 'first translated sentence', isFinal: false },
    { text: 'first translated sentence', isFinal: true }
  ]);
  assert.equal(inputEvents[0].sessionId, null);
  assert.equal(inputEvents[0].segmentId, null);
});

test('local silence finalization completes pending transcripts without provider input-end control', async () => {
  const inputEvents = [];
  const outputEvents = [];
  const cueEvents = [];
  const providerCalls = [];
  const session = new LiveTranslateSession({
    targetLanguageCode: 'en',
    silenceFinalizeMs: 20,
    onInputTranscript: (event) => inputEvents.push(event),
    onOutputTranscript: (event) => outputEvents.push(event),
    onCueEvent: (event) => cueEvents.push(event)
  });
  session.session = { sendRealtimeInput(payload) { providerCalls.push(payload); } };
  session.trackSpeechActivity(new Float32Array(160).fill(0.2));
  session.handleMessage({ serverContent: {
    inputTranscription: { text: 'first source' },
    outputTranscription: { text: 'first translation' }
  } });

  await new Promise((resolve) => setTimeout(resolve, 35));

  assert.deepEqual(inputEvents.map(({ text, isFinal }) => ({ text, isFinal })), [
    { text: 'first source', isFinal: false },
    { text: 'first source', isFinal: true }
  ]);
  assert.deepEqual(outputEvents.map(({ text, isFinal }) => ({ text, isFinal })), [
    { text: 'first translation', isFinal: false },
    { text: 'first translation', isFinal: true }
  ]);
  assert.equal(cueEvents.filter((event) => event.isFinal).length, 2);
  assert.equal(cueEvents.filter((event) => event.localFinalize).length, 1);
  assert.deepEqual(providerCalls, []);
  await session.cleanup({ closeSession: false });
});

test('local silence finalization does nothing without pending transcripts and provider boundaries do not duplicate it', async () => {
  const inputEvents = [];
  const providerCalls = [];
  const session = new LiveTranslateSession({
    targetLanguageCode: 'en',
    silenceFinalizeMs: 20,
    onInputTranscript: (event) => inputEvents.push(event)
  });
  session.session = { sendRealtimeInput(payload) { providerCalls.push(payload); } };

  session.trackSpeechActivity(new Float32Array(160).fill(0.2));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(inputEvents, []);

  session.trackSpeechActivity(new Float32Array(160).fill(0.2));
  session.handleMessage({ serverContent: { inputTranscription: { text: 'one sentence' } } });
  session.handleMessage({ serverContent: { turnComplete: true } });
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.deepEqual(inputEvents.map(({ text, isFinal }) => ({ text, isFinal })), [
    { text: 'one sentence', isFinal: false },
    { text: 'one sentence', isFinal: true }
  ]);
  assert.deepEqual(providerCalls, []);
  await session.cleanup({ closeSession: false });
});

test('new speech resets local silence finalization and cleanup cancels its timer', async () => {
  const inputEvents = [];
  const session = new LiveTranslateSession({
    targetLanguageCode: 'en',
    silenceFinalizeMs: 30,
    onInputTranscript: (event) => inputEvents.push(event)
  });

  session.trackSpeechActivity(new Float32Array(160).fill(0.2));
  await new Promise((resolve) => setTimeout(resolve, 20));
  session.trackSpeechActivity(new Float32Array(160).fill(0.2));
  session.handleMessage({ serverContent: { inputTranscription: { text: 'reset sentence' } } });
  await session.cleanup({ closeSession: false });
  await new Promise((resolve) => setTimeout(resolve, 35));

  assert.deepEqual(inputEvents.map(({ text, isFinal }) => ({ text, isFinal })), [
    { text: 'reset sentence', isFinal: false }
  ]);
  assert.equal(session.silenceFinalizeTimer, null);
});

test('interim input transcription emits a non-final source transcript without turn completion finalization', () => {
  const inputEvents = [];
  const session = new LiveTranslateSession({
    targetLanguageCode: 'ja',
    echoTargetLanguage: true,
    onInputTranscript: (event) => inputEvents.push(event)
  });

  session.handleMessage({
    serverContent: {
      interimInputTranscription: { text: 'interim source text' }
    }
  });
  session.handleMessage({ serverContent: { turnComplete: true } });

  assert.deepEqual(inputEvents.map(({ text, isFinal }) => ({ text, isFinal })), [
    { text: 'interim source text', isFinal: false }
  ]);
});

test('a standalone turn boundary flushes a pending input transcript', () => {
  const inputEvents = [];
  const session = new LiveTranslateSession({
    targetLanguageCode: 'ja',
    echoTargetLanguage: true,
    onInputTranscript: (event) => inputEvents.push(event)
  });

  session.handleMessage({
    serverContent: {
      inputTranscription: { text: 'pending source text' }
    }
  });
  session.handleMessage({ serverContent: { turnComplete: true } });

  assert.deepEqual(inputEvents.map(({ text, isFinal }) => ({ text, isFinal })), [
    { text: 'pending source text', isFinal: false },
    { text: 'pending source text', isFinal: true }
  ]);
});

test('late input transcription is marked for cumulative transcript repair', () => {
  const inputEvents = [];
  const session = new LiveTranslateSession({
    targetLanguageCode: 'en',
    echoTargetLanguage: true,
    onInputTranscript: (event) => inputEvents.push(event)
  });

  session.handleMessage({ serverContent: { turnComplete: true } });
  session.handleMessage({ serverContent: { inputTranscription: { text: '12345678' } } });

  assert.equal(inputEvents[0].isLateTranscript, true);
});

test('stop flushes buffered input audio before ending the realtime stream', async () => {
  const calls = [];
  const session = new LiveTranslateSession({ targetLanguageCode: 'en', echoTargetLanguage: true });
  session.session = {
    sendRealtimeInput(payload) { calls.push(payload); },
    close() {}
  };
  session.providerReady = true;
  session.inputSendingEnabled = true;
  session.chunker = {
    flush() { return [new Uint8Array([1, 2])]; },
    reset() {}
  };

  await session.stop();

  assert.equal(calls.length, 2);
  assert.ok(calls[0].audio?.data);
  assert.deepEqual(calls[1], { audioStreamEnd: true });
});

test('manual activity detection sends activityStart before PCM and activityEnd on stop', async () => {
  const calls = [];
  const session = new LiveTranslateSession({ targetLanguageCode: 'en' });
  session.session = { sendRealtimeInput(payload) { calls.push(payload); }, close() {} };
  session.providerReady = true;
  session.inputSendingEnabled = true;
  session.inputTurnMode = 'manual';
  session.chunker = { flush() { return [new Uint8Array([1, 2])]; }, reset() {} };

  session.sendInputAudioChunk(new Uint8Array([3, 4]));
  await session.stop();

  assert.deepEqual(calls.map((payload) => Object.keys(payload)[0]), ['activityStart', 'audio', 'audio', 'activityEnd']);
  assert.deepEqual(calls.at(-1), { activityEnd: {} });
});

test('void provider send is recorded as invocation evidence, not server acknowledgement', () => {
  const session = new LiveTranslateSession({ targetLanguageCode: 'en' });
  session.session = { sendRealtimeInput() {} };
  session.providerReady = true;
  session.inputSendingEnabled = true;

  session.sendInputAudioChunk(new Uint8Array([1, 2, 3]));

  assert.equal(session.pcmSendAttemptCount, 1);
  assert.equal(session.pcmSendAcceptedCount, 1);
  assert.equal(session.pcmSendAsyncRejectCount, 0);
});

test('provider sync send failure preserves capture and starts provider reconnect', async () => {
  const failures = [];
  const states = [];
  const session = new LiveTranslateSession({
    targetLanguageCode: 'en',
    onConnectionFailure: (failure) => failures.push(failure),
    onCaptureStateChange: (state) => states.push(state.state)
  });
  let cleanupCalls = 0;
  let reconnectCalls = 0;
  session.cleanup = async () => { cleanupCalls += 1; };
  session.reconnectProvider = async () => { reconnectCalls += 1; return false; };
  session.session = {
    sendRealtimeInput() { throw new Error('send failed'); },
    close() {}
  };
  session.providerReady = true;
  session.inputSendingEnabled = true;

  session.sendInputAudioChunk(new Uint8Array([1, 2]));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(session.pcmSendSyncThrowCount, 1);
  assert.equal(cleanupCalls, 0);
  assert.equal(reconnectCalls, 1);
  assert.deepEqual(failures, []);
  assert.deepEqual(states, ['provider-unavailable']);
  assert.equal(session.providerReady, false);
});

test('provider async send rejection preserves capture and starts one reconnect', async () => {
  const failures = [];
  const session = new LiveTranslateSession({
    targetLanguageCode: 'en',
    onConnectionFailure: (failure) => failures.push(failure)
  });
  let cleanupCalls = 0;
  let reconnectCalls = 0;
  session.cleanup = async () => { cleanupCalls += 1; };
  session.reconnectProvider = async () => { reconnectCalls += 1; return false; };
  session.session = {
    sendRealtimeInput() { return Promise.reject(new Error('async send failed')); },
    close() {}
  };
  session.providerReady = true;
  session.inputSendingEnabled = true;

  session.sendInputAudioChunk(new Uint8Array([1, 2]));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(session.pcmSendAsyncRejectCount, 1);
  assert.equal(cleanupCalls, 0);
  assert.equal(reconnectCalls, 1);
  assert.deepEqual(failures, []);
  assert.equal(session.providerReady, false);
});

test('provider error after capture starts does not stop the microphone', async () => {
  const states = [];
  const session = new LiveTranslateSession({ targetLanguageCode: 'en',
    onCaptureStateChange: ({ state }) => states.push(state) });
  let cleanupCalls = 0;
  session.cleanup = async () => { cleanupCalls += 1; };
  session.reconnectProvider = async () => false;
  session.captureEnabled = true;
  session.providerReady = true;
  session.inputSendingEnabled = true;
  await session.handleSessionError(new Error('provider offline'), session.providerEpoch);
  assert.equal(cleanupCalls, 0);
  assert.equal(session.captureEnabled, true);
  assert.equal(session.providerReady, false);
  assert.deepEqual(states, ['provider-unavailable']);
});

test('suspended audio context is resumed before capture continues', async () => {
  let resumeCount = 0;
  const session = new LiveTranslateSession({ targetLanguageCode: 'en' });
  session.audioContext = {
    state: 'suspended',
    resume: async () => { resumeCount += 1; session.audioContext.state = 'running'; }
  };

  assert.equal(await session.ensureAudioContextRunning(), true);
  assert.equal(resumeCount, 1);
});

test('audio health reports an AudioContext that cannot resume', async () => {
  const failures = [];
  const session = new LiveTranslateSession({
    targetLanguageCode: 'en',
    onConnectionFailure: (failure) => failures.push(failure)
  });
  session.audioContext = { state: 'suspended' };
  session.mediaStream = { getTracks: () => [] };
  session.captureEnabled = true;

  assert.equal(await session.checkAudioCaptureHealth(), false);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].reasonHint, 'audio_context_lost');
});

test('audio health preserves microphone-disconnected classification for ended tracks', async () => {
  const failures = [];
  const session = new LiveTranslateSession({
    targetLanguageCode: 'en',
    onConnectionFailure: (failure) => failures.push(failure)
  });
  session.audioContext = { state: 'running' };
  session.mediaStream = { getTracks: () => [{ readyState: 'ended' }] };
  session.captureEnabled = true;

  assert.equal(await session.checkAudioCaptureHealth(), false);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].reasonHint, 'microphone_disconnected');
});

test('AudioWorklet construction failure falls back to ScriptProcessor capture', async () => {
  const previousAudioWorkletNode = globalThis.AudioWorkletNode;
  const failures = [];
  const processors = [];
  const session = new LiveTranslateSession({
    targetLanguageCode: 'en',
    onConnectionFailure: (failure) => failures.push(failure)
  });
  session.captureProcessorMode = 'worklet';
  globalThis.AudioWorkletNode = class BrokenAudioWorkletNode {
    constructor() {
      throw new Error('AudioWorkletNode is unavailable in this browser');
    }
  };
  session.audioContext = {
    state: 'running',
    sampleRate: 16000,
    destination: {},
    createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
    createScriptProcessor: () => {
      const processor = { connect() {}, disconnect() {}, onaudioprocess: null };
      processors.push(processor);
      return processor;
    }
  };
  session.mediaStream = { getTracks: () => [] };
  session.chunker = { push() { return []; }, reset() {} };

  try {
    assert.equal(session.setupAudioCapture(), true);
    assert.equal(session.captureProcessorMode, 'script');
    assert.equal(processors.length, 1);
    assert.equal(typeof processors[0].onaudioprocess, 'function');
    assert.deepEqual(failures, []);
    assert.equal(session.failureDiagnostics.at(-1).reasonHint, 'audio_worklet_unavailable');
  } finally {
    if (previousAudioWorkletNode === undefined) delete globalThis.AudioWorkletNode;
    else globalThis.AudioWorkletNode = previousAudioWorkletNode;
    await session.cleanup({ closeSession: false });
  }
});

test('healthy AudioWorklet callback does not trigger fallback', async () => {
  const previousAudioWorkletNode = globalThis.AudioWorkletNode;
  const workletNodes = [];
  const processors = [];
  const session = new LiveTranslateSession({ targetLanguageCode: 'en' });
  session.captureProcessorMode = 'worklet';
  globalThis.AudioWorkletNode = class MockAudioWorkletNode {
    constructor() {
      this.port = { onmessage: null };
      workletNodes.push(this);
    }

    connect() {}

    disconnect() {}
  };
  session.audioContext = {
    state: 'running',
    sampleRate: 16000,
    destination: {},
    createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
    createScriptProcessor: () => {
      const processor = { connect() {}, disconnect() {}, onaudioprocess: null };
      processors.push(processor);
      return processor;
    }
  };
  session.mediaStream = { getTracks: () => [] };
  session.chunker = { push() { return []; }, reset() {} };

  try {
    session.setupAudioCapture();
    workletNodes[0].port.onmessage({ data: { type: 'pcm', processCount: 1, samples: new Float32Array(1600).buffer } });
    assert.equal(await session.checkAudioCaptureHealth(Date.now() + 4000), true);
    assert.equal(session.captureProcessorMode, 'worklet');
    assert.equal(workletNodes.length, 1);
    assert.equal(processors.length, 0);
  } finally {
    if (previousAudioWorkletNode === undefined) delete globalThis.AudioWorkletNode;
    else globalThis.AudioWorkletNode = previousAudioWorkletNode;
    await session.cleanup({ closeSession: false });
  }
});

test('startup first PCM timeout is classified as an audio pipeline failure', async () => {
  const session = new LiveTranslateSession({ targetLanguageCode: 'en', firstPcmTimeoutMs: 1 });
  session.firstPcmPromise = new Promise(() => {});

  await assert.rejects(
    () => session.waitForFirstPcm(),
    (error) => {
      const classification = classifyConnectionFailure({ reason: error.reasonHint });
      assert.equal(error.reasonHint, 'first_pcm_timeout');
      assert.equal(error.userMessage, '錄音音訊管線未啟動，請重試。');
      assert.equal(classification.category, 'audio_pipeline');
      assert.equal(classification.safeMessage, '錄音音訊管線未啟動，請重試。');
      return true;
    }
  );
});

test('stalled AudioWorklet callback falls back to ScriptProcessor and does not duplicate the graph', async () => {
  const previousAudioWorkletNode = globalThis.AudioWorkletNode;
  const failures = [];
  const workletNodes = [];
  const processors = [];
  const sources = [];
  const session = new LiveTranslateSession({
    targetLanguageCode: 'en',
    onConnectionFailure: (failure) => failures.push(failure)
  });
  session.captureProcessorMode = 'worklet';
  globalThis.AudioWorkletNode = class MockAudioWorkletNode {
    constructor() {
      this.port = { onmessage: null };
      this.disconnectCalls = 0;
      workletNodes.push(this);
    }

    connect() {}

    disconnect() {
      this.disconnectCalls += 1;
    }
  };
  session.audioContext = {
    state: 'running',
    sampleRate: 16000,
    destination: {},
    createMediaStreamSource: () => {
      const source = { connect() {}, disconnect() {} };
      sources.push(source);
      return source;
    },
    createScriptProcessor: () => {
      const processor = { connect() {}, disconnect() {}, onaudioprocess: null };
      processors.push(processor);
      return processor;
    }
  };
  session.mediaStream = { getTracks: () => [] };
  session.chunker = { push() { return []; }, reset() {} };
  session.session = { sendRealtimeInput() {} };
  session.providerReady = true;

  try {
    assert.equal(session.setupAudioCapture(), true);
    assert.equal(session.captureProcessorMode, 'worklet');
    assert.equal(await session.checkAudioCaptureHealth(Date.now() + 4000), true);
    assert.equal(session.captureProcessorMode, 'script');
    assert.equal(workletNodes.length, 1);
    assert.equal(workletNodes[0].disconnectCalls, 1);
    assert.equal(workletNodes[0].port.onmessage, null);
    assert.equal(processors.length, 1);
    assert.equal(sources.length, 2);
    assert.equal(session.audioCaptureStage, 'script_processor_selected');
    assert.equal(failures.length, 0);
    assert.equal(session.failureDiagnostics.at(-1).reasonHint, 'audio_callback_not_received');

    session.chunker = { push() { return [new Uint8Array([1, 2, 3, 4])]; }, reset() {} };
    session.inputSendingEnabled = true;
    processors[0].onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(1600) } });
    assert.equal(session.captureProcessorMode, 'script');
    assert.equal(session.audioCallbackCount, 1);

    // The next health cycle may retry ScriptProcessor once, but never rebuilds
    // the Worklet or reports a failure until ScriptProcessor also stalls twice.
    assert.equal(await session.checkAudioCaptureHealth(Date.now() + 4000), true);
    assert.equal(workletNodes.length, 1);
    assert.equal(processors.length, 2);
    assert.equal(failures.length, 0);
    await session.checkAudioCaptureHealth(Date.now() + 4000);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].reasonHint, 'audio_capture_failed');
    assert.equal(failures[0].diagnostic.audioCaptureStage, 'script_processor_callback_failed');
    const processorCount = processors.length;
    await session.cleanup({ closeSession: false });
    await session.checkAudioCaptureHealth(Date.now() + 8000);
    assert.equal(processors.length, processorCount);
  } finally {
    if (previousAudioWorkletNode === undefined) delete globalThis.AudioWorkletNode;
    else globalThis.AudioWorkletNode = previousAudioWorkletNode;
    await session.cleanup({ closeSession: false });
  }
});

test('healthy audio callbacks reset the transient capture-stall recovery budget', async () => {
  const failures = [];
  const processors = [];
  const session = new LiveTranslateSession({
    targetLanguageCode: 'en',
    onConnectionFailure: (failure) => failures.push(failure)
  });
  session.audioContext = {
    state: 'running',
    sampleRate: 16000,
    destination: {},
    createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
    createScriptProcessor: () => {
      const processor = { connect() {}, disconnect() {}, onaudioprocess: null };
      processors.push(processor);
      return processor;
    }
  };
  session.mediaStream = { getTracks: () => [] };
  session.chunker = { push() { return []; }, reset() {} };
  session.session = { sendRealtimeInput() {} };
  session.providerReady = true;

  session.setupAudioCapture();
  processors[0].onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(1600) } });
  assert.equal(await session.checkAudioCaptureHealth(Date.now() + 4000), true);
  assert.equal(processors.length, 2);
  assert.equal(session.captureRecoveryCount, 1);

  processors.at(-1).onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(1600) } });
  assert.equal(session.captureRecoveryCount, 0);
  assert.equal(await session.checkAudioCaptureHealth(Date.now() + 4000), true);
  assert.equal(processors.length, 3);
  assert.equal(session.captureRecoveryCount, 1);
  assert.deepEqual(failures, []);

  await session.cleanup({ closeSession: false });
});

test('input audio callback before provider session is ready is buffered and drained later', () => {
  const sent = [];
  const captured = [];
  const processor = { connect() {}, disconnect() {}, onaudioprocess: null };
  const source = { connect() {}, disconnect() {} };
  const session = new LiveTranslateSession({
    targetLanguageCode: 'en',
    echoTargetLanguage: true,
    onInputAudioChunk: (chunk) => captured.push(chunk)
  });
  session.audioContext = { destination: {} };
  session.mediaStream = {};
  session.chunker = {
    push() { return [new Uint8Array([1, 2, 3, 4])]; },
    reset() {}
  };
  session.audioContext.createMediaStreamSource = () => source;
  session.audioContext.createScriptProcessor = () => processor;
  session.providerReady = true;
  session.inputSendingEnabled = true;

  session.setupAudioCapture();
  processor.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(1600) } });

  assert.equal(captured.length, 1);
  assert.equal(session.pendingInputAudioChunks.length, 1);

  session.session = { sendRealtimeInput(payload) { sent.push(payload); } };
  processor.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(1600) } });

  assert.equal(captured.length, 2);
  assert.equal(sent.length, 1);
  session.drainPreRoll();
  assert.equal(sent.length, 2);
  assert.equal(session.pendingInputAudioChunks.length, 0);
});

test('stale provider callbacks from an older connection epoch are ignored', async () => {
  const events = [];
  const session = new LiveTranslateSession({
    targetLanguageCode: 'en',
    connectionEpoch: 2,
    onInputTranscript: (event) => events.push(['input', event]),
    onOutputTranscript: (event) => events.push(['output', event]),
    onClose: () => events.push(['close']),
    onError: () => events.push(['error'])
  });

  session.handleMessage({
    serverContent: {
      inputTranscription: { text: 'stale source' },
      outputTranscription: { text: 'stale translation' },
      turnComplete: true
    }
  }, 1);
  await session.handleSessionError(new Error('stale error'), 1);
  await session.handleSessionClose({ reason: 'stale close' }, 1);

  assert.deepEqual(events, []);
});

test('old audio processor closure cannot send after the connection epoch changes', () => {
  const sent = [];
  const processor = { connect() {}, disconnect() {}, onaudioprocess: null };
  const session = new LiveTranslateSession({ targetLanguageCode: 'en', connectionEpoch: 4 });
  session.audioContext = {
    sampleRate: 16000,
    destination: {},
    createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
    createScriptProcessor: () => processor
  };
  session.mediaStream = {};
  session.chunker = {
    push() { return [new Uint8Array([1, 2])]; },
    flush() { return []; },
    reset() {}
  };
  session.session = { sendRealtimeInput(payload) { sent.push(payload); } };
  session.providerReady = true;
  session.inputSendingEnabled = true;
  session.setupAudioCapture();
  session.connectionEpoch = 5;

  processor.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(1600) } });

  assert.deepEqual(sent, []);
  assert.equal(session.audioCallbackCount, 0);
  assert.equal(session.lastAudioCallbackAt, null);
});

test('pending input audio keeps only the bounded newest window', () => {
  const session = new LiveTranslateSession({ targetLanguageCode: 'en', echoTargetLanguage: true });
  for (let index = 0; index < 70; index += 1) {
    session.queuePendingInputAudioChunk(new Uint8Array([index]));
  }

  assert.equal(session.pendingInputAudioChunks.length, 64);
  assert.equal(session.pendingInputAudioChunks[0].bytes[0], 6);
  assert.equal(session.pendingInputAudioChunks.at(-1).bytes[0], 69);
});

test('polishing configuration cannot change PCM chunks sent to Gemini Live', () => {
  const createSession = () => {
    const calls = [];
    const session = new LiveTranslateSession({ targetLanguageCode: 'en', echoTargetLanguage: true });
    session.session = { sendRealtimeInput(payload) { calls.push(payload); } };
    session.chunker = { flush() { return [new Uint8Array([1, 2, 3, 4])]; } };
    session.onInputAudioChunk = () => {};
    session.flushInputAudio();
    return calls;
  };

  assert.deepEqual(createSession(), createSession());
});

test('final input transcription replaces interim source while preserving translation transcript', () => {
  const inputEvents = [];
  const outputEvents = [];
  const session = new LiveTranslateSession({
    targetLanguageCode: 'ja',
    echoTargetLanguage: true,
    onInputTranscript: (event) => inputEvents.push(event),
    onOutputTranscript: (event) => outputEvents.push(event)
  });

  session.handleMessage({
    serverContent: {
      interimInputTranscription: { text: 'interim source' },
      outputTranscription: { text: 'translated text' }
    }
  });
  session.handleMessage({
    serverContent: {
      inputTranscription: { text: 'final source' },
      turnComplete: true
    }
  });
  session.handleMessage({ serverContent: { turnComplete: true } });

  assert.deepEqual(inputEvents.map(transcriptEventSummary), [
    { text: 'interim source', isFinal: false, sourceLanguageCode: 'zh-Hant' },
    { text: 'final source', isFinal: true, sourceLanguageCode: 'zh-Hant' }
  ]);
  assert.deepEqual(outputEvents.map(({ text, isFinal }) => ({ text, isFinal })), [
    { text: 'translated text', isFinal: false },
    { text: 'translated text', isFinal: true }
  ]);
});

test('output-only transcript does not fabricate source transcript text', () => {
  const inputEvents = [];
  const outputEvents = [];
  const session = new LiveTranslateSession({
    targetLanguageCode: 'ja',
    echoTargetLanguage: true,
    onInputTranscript: (event) => inputEvents.push(event),
    onOutputTranscript: (event) => outputEvents.push(event)
  });

  session.handleMessage({
    serverContent: {
      outputTranscription: { text: 'translated only' },
      turnComplete: true
    }
  });

  assert.deepEqual(inputEvents, []);
  assert.deepEqual(outputEvents.map(transcriptEventSummary), [{ text: 'translated only', isFinal: true, sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'ja' }]);
});

test('live session applies glossary replacements only to output transcript events', () => {
  const inputEvents = [];
  const outputEvents = [];
  const session = new LiveTranslateSession({
    targetLanguageCode: 'en',
    echoTargetLanguage: true,
    liveGlossaryEntries: [
      { source: 'microphone', target: 'Alan speak', replacementAliases: ['mic'] }
    ],
    onInputTranscript: (event) => inputEvents.push(event),
    onOutputTranscript: (event) => outputEvents.push(event)
  });

  session.handleMessage({
    serverContent: {
      inputTranscription: { text: 'microphone' },
      outputTranscription: { text: 'microphone and mic' },
      turnComplete: true
    }
  });

  assert.deepEqual(inputEvents.map(transcriptEventSummary), [{ text: 'microphone', isFinal: true, sourceLanguageCode: 'zh-Hant' }]);
  assert.deepEqual(outputEvents.map(transcriptEventSummary), [{ text: 'Alan speak', isFinal: true, sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en' }]);
});

test('live session emits final output transcript events after glossary replacement', () => {
  const outputEvents = [];
  const session = new LiveTranslateSession({
    targetLanguageCode: 'en',
    echoTargetLanguage: true,
    liveGlossaryEntries: [
      { source: 'microphone', target: 'Alan speak', replacementAliases: [] }
    ],
    onOutputTranscript: (event) => outputEvents.push(event)
  });

  session.handleMessage({
    serverContent: {
      inputTranscription: { text: 'microphone' },
      outputTranscription: { text: 'microphone' },
      turnComplete: true
    }
  });

  assert.deepEqual(outputEvents.map(transcriptEventSummary), [{ text: 'Alan speak', isFinal: true, sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en' }]);
});

test('turn completion flush keeps replacement text when finalizing output partials', () => {
  const outputEvents = [];
  const session = new LiveTranslateSession({
    targetLanguageCode: 'en',
    echoTargetLanguage: true,
    liveGlossaryEntries: [
      { source: 'microphone', target: 'Alan speak', replacementAliases: [] }
    ],
    onOutputTranscript: (event) => outputEvents.push(event)
  });

  session.handleMessage({
    serverContent: {
      inputTranscription: { text: 'microphone' },
      outputTranscription: { text: 'microphone' }
    }
  });
  session.handleMessage({ serverContent: { turnComplete: true } });

  assert.deepEqual(outputEvents.map(transcriptEventSummary), [
    { text: 'Alan speak', isFinal: false, sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en' },
    { text: 'Alan speak', isFinal: true, sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en' }
  ]);
});

test('rapid consecutive live transcript turns emit every completed source and translation segment', () => {
  const inputEvents = [];
  const outputEvents = [];
  const session = new LiveTranslateSession({
    targetLanguageCode: 'ja',
    echoTargetLanguage: true,
    onInputTranscript: (event) => inputEvents.push(event),
    onOutputTranscript: (event) => outputEvents.push(event)
  });

  for (const [sourceText, translationText] of [
    ['第一句', '第一句翻譯'],
    ['第二句', '第二句翻譯'],
    ['第三句', '第三句翻譯']
  ]) {
    session.handleMessage({
      serverContent: {
        inputTranscription: { text: sourceText },
        outputTranscription: { text: translationText }
      }
    });
    session.handleMessage({ serverContent: { turnComplete: true } });
  }

  assert.deepEqual(inputEvents.filter((event) => event.isFinal).map((event) => event.text), [
    '第一句',
    '第二句',
    '第三句'
  ]);
  assert.deepEqual(outputEvents.filter((event) => event.isFinal).map((event) => event.text), [
    '第一句翻譯',
    '第二句翻譯',
    '第三句翻譯'
  ]);
});

test('turn completion received before transcripts finalizes the next source and translation segments', () => {
  const inputEvents = [];
  const outputEvents = [];
  const session = new LiveTranslateSession({
    targetLanguageCode: 'ja',
    echoTargetLanguage: true,
    onInputTranscript: (event) => inputEvents.push(event),
    onOutputTranscript: (event) => outputEvents.push(event)
  });

  session.handleMessage({ serverContent: { turnComplete: true } });
  session.handleMessage({
    serverContent: {
      inputTranscription: { text: 'late source sentence' },
      outputTranscription: { text: 'late translated sentence' }
    }
  });

  assert.deepEqual(inputEvents.map(transcriptEventSummary), [{ text: 'late source sentence', isFinal: true, isLateTranscript: true, sourceLanguageCode: 'zh-Hant' }]);
  assert.deepEqual(outputEvents.map(transcriptEventSummary), [{ text: 'late translated sentence', isFinal: true, isLateTranscript: true, sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'ja' }]);
});

test('session stop flushes pending source and translation transcripts once', async () => {
  const inputEvents = [];
  const outputEvents = [];
  const session = new LiveTranslateSession({
    targetLanguageCode: 'ja',
    echoTargetLanguage: true,
    onInputTranscript: (event) => inputEvents.push(event),
    onOutputTranscript: (event) => outputEvents.push(event)
  });
  session.cleanup = async () => {};

  session.handleMessage({
    serverContent: {
      inputTranscription: { text: 'last source' },
      outputTranscription: { text: 'last translation' }
    }
  });
  await session.stop();
  await session.stop();

  assert.deepEqual(inputEvents.map(({ text, isFinal }) => ({ text, isFinal })), [
    { text: 'last source', isFinal: false },
    { text: 'last source', isFinal: true }
  ]);
  assert.deepEqual(outputEvents.map(({ text, isFinal }) => ({ text, isFinal })), [
    { text: 'last translation', isFinal: false },
    { text: 'last translation', isFinal: true }
  ]);
});

test('stop marks unconfirmed provider partials as saved-pending terminal state', () => {
  const inputEvents = [];
  const session = new LiveTranslateSession({
    targetLanguageCode: 'en',
    onInputTranscript: (event) => inputEvents.push(event)
  });
  session.pendingInputTranscript = { text: '最後一句', isFinal: false };
  session.lastInputEnd = { method: 'audioStreamEnd', result: 'sdk-returned-void' };

  session.flushPendingTranscripts();

  assert.equal(inputEvents[0].isFinal, true);
  assert.equal(inputEvents[0].terminalStatus, 'saved-pending');
  assert.equal(inputEvents[0].terminalReason, 'provider-final-unconfirmed');
  assert.equal(inputEvents[0].providerEndMethod, 'audioStreamEnd');
  assert.equal(inputEvents[0].providerEndResult, 'sdk-returned-void');
});

test('session stop flush preserves mixed-source output and marks glossary correction uncertain', async () => {
  const inputEvents = [];
  const outputEvents = [];
  const session = new LiveTranslateSession({
    targetLanguageCode: 'en',
    echoTargetLanguage: true,
    liveGlossaryEntries: [
      { source: 'microphone', target: 'Alan speak', replacementAliases: [] }
    ],
    onInputTranscript: (event) => inputEvents.push(event),
    onOutputTranscript: (event) => outputEvents.push(event)
  });
  session.cleanup = async () => {};

  session.handleMessage({
    serverContent: {
      inputTranscription: { text: 'microphone source' },
      outputTranscription: { text: 'microphone' }
    }
  });
  await session.stop();

  assert.deepEqual(inputEvents.map(({ text, isFinal }) => ({ text, isFinal })), [
    { text: 'microphone source', isFinal: false },
    { text: 'microphone source', isFinal: true }
  ]);
  assert.deepEqual(outputEvents.map(({ text, isFinal, glossaryCorrectionStatus }) => ({ text, isFinal, glossaryCorrectionStatus })), [
    { text: 'microphone', isFinal: false, glossaryCorrectionStatus: 'correction_uncertain' },
    { text: 'microphone', isFinal: true, glossaryCorrectionStatus: 'correction_uncertain' }
  ]);
});

test('cleanup releases audio resources and handlers idempotently', async () => {
  const calls = [];
  const track = {
    stop() {
      calls.push('track.stop');
    }
  };
  const playbackSource = {
    onended: () => {},
    stop() {
      calls.push('playback.stop');
    },
    disconnect() {
      calls.push('playback.disconnect');
    }
  };
  const processor = {
    onaudioprocess: () => {},
    disconnect() {
      calls.push('processor.disconnect');
    }
  };
  const source = {
    disconnect() {
      calls.push('source.disconnect');
    }
  };
  const liveSession = {
    sendRealtimeInput(payload) {
      calls.push(['sendRealtimeInput', payload]);
    },
    close() {
      calls.push('session.close');
    }
  };
  const audioContext = {
    state: 'running',
    currentTime: 12,
    async close() {
      calls.push('audioContext.close');
      this.state = 'closed';
    }
  };
  const chunker = {
    reset() {
      calls.push('chunker.reset');
    }
  };
  const session = new LiveTranslateSession({
    targetLanguageCode: 'ja',
    echoTargetLanguage: true
  });
  session.audioContext = audioContext;
  session.mediaStream = { getTracks: () => [track] };
  session.source = source;
  session.processor = processor;
  session.session = liveSession;
  session.chunker = chunker;
  session.providerReady = true;
  session.inputSendingEnabled = true;
  session.pendingInputTranscript = { text: 'pending source' };
  session.pendingOutputTranscript = { text: 'pending output' };
  session.awaitingInputTranscriptAfterTurnComplete = true;
  session.awaitingOutputTranscriptAfterTurnComplete = true;
  session.playbackSources.add(playbackSource);

  await session.cleanup({ closeSession: true, signalAudioEnd: true });
  await session.cleanup({ closeSession: true, signalAudioEnd: true });

  assert.deepEqual(calls, [
    ['sendRealtimeInput', { audioStreamEnd: true }],
    'chunker.reset',
    'track.stop',
    'processor.disconnect',
    'source.disconnect',
    'session.close',
    'audioContext.close',
    'playback.stop',
    'playback.disconnect'
  ]);
  assert.equal(processor.onaudioprocess, null);
  assert.equal(playbackSource.onended, null);
  assert.equal(session.processor, null);
  assert.equal(session.source, null);
  assert.equal(session.mediaStream, null);
  assert.equal(session.session, null);
  assert.equal(session.audioContext, null);
  assert.equal(session.chunker, null);
  assert.equal(session.pendingInputTranscript, null);
  assert.equal(session.pendingOutputTranscript, null);
  assert.equal(session.awaitingInputTranscriptAfterTurnComplete, false);
  assert.equal(session.awaitingOutputTranscriptAfterTurnComplete, false);
  assert.equal(session.playbackSources.size, 0);
  assert.equal(session.nextPlaybackTime, 0);
  assert.equal(session.cleaningUp, false);
});

test('retranslateSourceText sends one client-content turn and respects closed guard', () => {
  const calls = [];
  const session = new LiveTranslateSession({ targetLanguageCode: 'en', echoTargetLanguage: true });
  session.session = {
    sendClientContent(payload) { calls.push(payload); },
    close() {}
  };

  assert.equal(session.retranslateSourceText('你好', 'cue-1'), true);
  assert.equal(session.retranslateSourceText('你好', 'cue-1'), false);
  assert.deepEqual(calls, [{
    turns: [{
      role: 'user',
      parts: [{ text: 'Translate the following source text into en. Preserve every digit exactly and return only the translation, without explanation:\n你好' }]
    }],
    turnComplete: true
  }]);

  session.closed = true;
  assert.equal(session.retranslateSourceText('再見', 'cue-2'), false);
});

test('numeric correction output is tagged with its Cue and does not request playback audio', () => {
  const outputEvents = [];
  const audioEvents = [];
  const session = new LiveTranslateSession({
    targetLanguageCode: 'en',
    echoTargetLanguage: true,
    onOutputTranscript: (event) => outputEvents.push(event),
    onOutputAudioChunk: (chunk) => audioEvents.push(chunk)
  });
  session.session = { sendClientContent() {}, close() {} };
  session.retranslateSourceText('現在是下午4點50分。', 'cue-1');

  session.handleMessage({
    serverContent: {
      outputTranscription: { text: "Right now it's 4:50 PM." },
      turnComplete: true,
      modelTurn: { parts: [{ inlineData: { data: 'AQID' } }] }
    }
  });

  assert.equal(outputEvents[0].retranslationCueId, 'cue-1');
  assert.deepEqual(audioEvents, []);
});

function transcriptEventSummary(event) {
  return {
    text: event.text,
    isFinal: event.isFinal,
    ...(event.isLateTranscript ? { isLateTranscript: true } : {}),
    ...(event.sourceLanguageCode ? { sourceLanguageCode: event.sourceLanguageCode } : {}),
    ...(event.targetLanguageCode ? { targetLanguageCode: event.targetLanguageCode } : {})
  };
}

function createTestSession({ events = [], onConnectionFailure, onError, onClose } = {}) {
  const session = new LiveTranslateSession({
    targetLanguageCode: 'ja',
    echoTargetLanguage: true,
    onConnectionFailure,
    onError,
    onClose
  });

  session.cleanup = async () => {
    events.push('cleanup');
  };

  return session;
}

function createFakeTimer() {
  let nextId = 1;
  const pending = new Map();

  return {
    set(callback, delayMs) {
      const handle = { id: nextId++ };
      pending.set(handle.id, { callback, delayMs });
      return handle;
    },
    clear(handle) {
      if (handle) {
        pending.delete(handle.id);
      }
    },
    pendingCount() {
      return pending.size;
    }
  };
}
test('reconnect passes the latest session resumption handle to live.connect config', async () => {
  const originalFetch = globalThis.fetch;
  const probe = new GoogleGenAI({ apiKey: 'test-token' });
  const livePrototype = Object.getPrototypeOf(probe.live);
  const originalConnect = livePrototype.connect;
  let connectOptions;
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return {
        token: 'ephemeral-token',
        expiresAt: '2099-01-01T00:00:00.000Z',
        liveConnectModel: 'gemini-3.5-live-translate-preview',
        liveConnectConfig: { responseModalities: ['AUDIO'] }
      };
    }
  });
  livePrototype.connect = async (options) => {
    connectOptions = options;
    return { close() {} };
  };

  try {
    const session = new LiveTranslateSession({ targetLanguageCode: 'en' });
    session.resumptionHandle = 'latest-resume-handle';
    session.waitForSetupComplete = async () => true;
    session.attachAudioCaptureAfterSetup = async () => true;
    await session.connectProvider();
    assert.equal(connectOptions.config.sessionResumption.handle, 'latest-resume-handle');
  } finally {
    livePrototype.connect = originalConnect;
    globalThis.fetch = originalFetch;
  }
});
