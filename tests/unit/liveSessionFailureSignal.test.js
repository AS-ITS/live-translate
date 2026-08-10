import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyConnectionFailure } from '../../src/lib/connectionFailures.js';
import { LiveTranslateSession } from '../../src/lib/liveSession.js';
import { createReconnectController } from '../../src/lib/reconnectController.js';

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

  assert.deepEqual(inputEvents, [
    { text: 'first source sentence', isFinal: false },
    { text: 'first source sentence', isFinal: true }
  ]);
  assert.deepEqual(outputEvents, [
    { text: 'first translated sentence', isFinal: false },
    { text: 'first translated sentence', isFinal: true }
  ]);
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

  assert.deepEqual(inputEvents, [
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
  session.chunker = {
    flush() { return [new Uint8Array([1, 2])]; },
    reset() {}
  };

  await session.stop();

  assert.equal(calls.length, 2);
  assert.ok(calls[0].audio?.data);
  assert.deepEqual(calls[1], { audioStreamEnd: true });
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

  assert.deepEqual(inputEvents, [
    { text: 'interim source', isFinal: false },
    { text: 'final source', isFinal: true }
  ]);
  assert.deepEqual(outputEvents, [
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
  assert.deepEqual(outputEvents, [{ text: 'translated only', isFinal: true }]);
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
      inputTranscription: { text: '麥克風' },
      outputTranscription: { text: 'microphone and mic' },
      turnComplete: true
    }
  });

  assert.deepEqual(inputEvents, [{ text: '麥克風', isFinal: true }]);
  assert.deepEqual(outputEvents, [{ text: 'Alan speak and Alan speak', isFinal: true }]);
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
      outputTranscription: { text: 'microphone' },
      turnComplete: true
    }
  });

  assert.deepEqual(outputEvents, [{ text: 'Alan speak', isFinal: true }]);
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
      outputTranscription: { text: 'microphone' }
    }
  });
  session.handleMessage({ serverContent: { turnComplete: true } });

  assert.deepEqual(outputEvents, [
    { text: 'Alan speak', isFinal: false },
    { text: 'Alan speak', isFinal: true }
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

  assert.deepEqual(inputEvents, [{ text: 'late source sentence', isFinal: true, isLateTranscript: true }]);
  assert.deepEqual(outputEvents, [{ text: 'late translated sentence', isFinal: true, isLateTranscript: true }]);
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

  assert.deepEqual(inputEvents, [
    { text: 'last source', isFinal: false },
    { text: 'last source', isFinal: true }
  ]);
  assert.deepEqual(outputEvents, [
    { text: 'last translation', isFinal: false },
    { text: 'last translation', isFinal: true }
  ]);
});

test('session stop flush applies glossary replacement to pending output without changing input', async () => {
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

  assert.deepEqual(inputEvents, [
    { text: 'microphone source', isFinal: false },
    { text: 'microphone source', isFinal: true }
  ]);
  assert.deepEqual(outputEvents, [
    { text: 'Alan speak', isFinal: false },
    { text: 'Alan speak', isFinal: true }
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
  session.pendingInputTranscript = { text: 'pending source' };
  session.pendingOutputTranscript = { text: 'pending output' };
  session.awaitingInputTranscriptAfterTurnComplete = true;
  session.awaitingOutputTranscriptAfterTurnComplete = true;
  session.playbackSources.add(playbackSource);

  await session.cleanup({ closeSession: true, signalAudioEnd: true });
  await session.cleanup({ closeSession: true, signalAudioEnd: true });

  assert.deepEqual(calls, [
    'chunker.reset',
    'playback.stop',
    'playback.disconnect',
    ['sendRealtimeInput', { audioStreamEnd: true }],
    'processor.disconnect',
    'source.disconnect',
    'track.stop',
    'session.close',
    'audioContext.close'
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
