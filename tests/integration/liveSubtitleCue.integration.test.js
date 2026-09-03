import assert from 'node:assert/strict';
import test from 'node:test';
import { LiveTranslateSession } from '../../src/lib/liveSession.js';
import { LiveTranscriptionSession } from '../../src/lib/liveTranscriptionSession.js';
import {
  applySubtitleCueEvent,
  createSubtitleCueState,
  finalizePendingSubtitleCue,
  resolveIdleSubtitleCue
} from '../../src/lib/subtitleCues.js';

test('Gemini mock event flow produces one final cue from input/output partials', () => {
  let cueState = createSubtitleCueState();
  let clock = 0;
  const session = new LiveTranslateSession({
    liveSessionId: 'live-1',
    targetLanguageCode: 'en',
    sourceLanguageCode: 'zh-Hant',
    echoTargetLanguage: true,
    sessionClock: () => (clock += 50),
    onCueEvent: (event) => {
      cueState = applySubtitleCueEvent(cueState, event);
    }
  });

  session.handleMessage({ eventId: 'input-1', serverContent: { inputTranscription: { text: 'hello wor' } } });
  session.handleMessage({ eventId: 'input-2', serverContent: { inputTranscription: { text: 'hello world' } } });
  session.handleMessage({ eventId: 'output-1', serverContent: { outputTranscription: { text: 'bonjour le monde' } } });
  session.handleMessage({ eventId: 'boundary-1', serverContent: { turnComplete: true } });
  const firstCandidate = cueState.currentCue || cueState.pendingCues[0];
  cueState = resolveIdleSubtitleCue(cueState, {
    cueId: firstCandidate.cueId,
    updatedTimeMs: firstCandidate.updatedTimeMs,
    sessionTimeMs: firstCandidate.boundaryAtMs + 700
  }).state;

  assert.equal(cueState.finalCues.length, 1);
  assert.equal(cueState.finalCues[0].sourceText, 'hello world');
  assert.equal(cueState.finalCues[0].translatedText, 'bonjour le monde');
  assert.equal(cueState.currentCue, null);
});

test('terminal transcript flush emits final Cue events for pending subtitles', () => {
  let cueState = createSubtitleCueState();
  let clock = 0;
  const session = new LiveTranslateSession({
    liveSessionId: 'live-terminal-flush',
    sessionId: 'session-terminal-flush',
    segmentId: 'segment-terminal-flush',
    targetLanguageCode: 'en',
    sourceLanguageCode: 'zh-Hant',
    sessionClock: () => (clock += 50),
    onCueEvent: (event) => {
      cueState = applySubtitleCueEvent(cueState, event);
    }
  });

  session.handleMessage({
    eventId: 'pending-source',
    serverContent: { inputTranscription: { text: '最後一句原文' } }
  });
  session.handleMessage({
    eventId: 'pending-translation',
    serverContent: { outputTranscription: { text: 'the final source sentence' } }
  });

  session.flushPendingTranscripts();
  cueState = finalizePendingSubtitleCue(cueState, { sessionTimeMs: clock + 700, reason: 'pause' });

  assert.equal(cueState.finalCues.length, 1);
  assert.deepEqual(
    [cueState.finalCues[0].sourceText, cueState.finalCues[0].translatedText],
    ['最後一句原文', 'the final source sentence']
  );
});

test('local silence finalize commits a complete Cue immediately without ending provider audio', async () => {
  let cueState = createSubtitleCueState();
  let clock = 0;
  const providerCalls = [];
  const session = new LiveTranslateSession({
    liveSessionId: 'live-local-silence',
    targetLanguageCode: 'en',
    sourceLanguageCode: 'zh-Hant',
    silenceFinalizeMs: 20,
    sessionClock: () => (clock += 50),
    onCueEvent: (event) => {
      cueState = applySubtitleCueEvent(cueState, event);
      if (event.localFinalize) {
        cueState = finalizePendingSubtitleCue(cueState, {
          sessionTimeMs: clock + 1,
          reason: event.finalizedReason
        });
      }
    }
  });
  session.session = { sendRealtimeInput(payload) { providerCalls.push(payload); } };

  session.trackSpeechActivity(new Float32Array(160).fill(0.2));
  session.handleMessage({ eventId: 'local-source', serverContent: { inputTranscription: { text: '第一句原文' } } });
  session.handleMessage({ eventId: 'local-translation', serverContent: { outputTranscription: { text: 'first translation' } } });
  await new Promise((resolve) => setTimeout(resolve, 35));

  assert.equal(cueState.finalCues.length, 1);
  assert.deepEqual(
    [cueState.finalCues[0].sourceText, cueState.finalCues[0].translatedText, cueState.finalCues[0].finalizedReason],
    ['第一句原文', 'first translation', 'localSilence']
  );
  assert.equal(cueState.currentCue, null);
  assert.deepEqual(providerCalls, []);
  await session.cleanup({ closeSession: false });
});

test('Gemini incremental fragments without turnIndex remain one final cue', () => {
  let cueState = createSubtitleCueState();
  let clock = 0;
  const session = new LiveTranslateSession({
    liveSessionId: 'live-fragments',
    targetLanguageCode: 'en',
    sourceLanguageCode: 'zh-Hant',
    echoTargetLanguage: true,
    sessionClock: () => (clock += 50),
    onCueEvent: (event) => {
      cueState = applySubtitleCueEvent(cueState, event);
    }
  });

  session.handleMessage({ eventId: 'source-1', serverContent: { inputTranscription: { text: "it's a voice" } } });
  session.handleMessage({ eventId: 'source-2', serverContent: { inputTranscription: { text: 'input.' } } });
  session.handleMessage({ eventId: 'translation-1', serverContent: { outputTranscription: { text: '這是語音' } } });
  session.handleMessage({ eventId: 'translation-2', serverContent: { outputTranscription: { text: '輸入。' } } });
  cueState = finalizePendingSubtitleCue(cueState, { sessionTimeMs: 300, reason: 'turnComplete' });

  assert.equal(cueState.finalCues.length, 1);
  assert.equal(cueState.currentCue, null);
  assert.deepEqual(cueState.finalCues.map((cue) => [cue.sourceText, cue.translatedText]), [[
    "it's a voice input.",
    '這是語音輸入。'
  ]]);
});

test('late transcript after Turn completion finalizes the Cue instead of leaving a partial', () => {
  let cueState = createSubtitleCueState();
  let clock = 0;
  const session = new LiveTranslateSession({
    liveSessionId: 'live-late-transcript',
    targetLanguageCode: 'en',
    sourceLanguageCode: 'zh-Hant',
    sessionClock: () => (clock += 50),
    onCueEvent: (event) => {
      cueState = applySubtitleCueEvent(cueState, event);
    }
  });

  session.handleMessage({ eventId: 'boundary-first', serverContent: { turnComplete: true } });
  session.handleMessage({ eventId: 'late-source', serverContent: { inputTranscription: { text: 'late source' } } });
  session.handleMessage({ eventId: 'late-translation', serverContent: { outputTranscription: { text: 'late translation' } } });
  const lateCandidate = cueState.currentCue || cueState.pendingCues[0];
  cueState = resolveIdleSubtitleCue(cueState, {
    cueId: lateCandidate.cueId,
    updatedTimeMs: lateCandidate.updatedTimeMs,
    sessionTimeMs: lateCandidate.boundaryAtMs + 700
  }).state;

  assert.equal(cueState.currentCue, null);
  assert.deepEqual(cueState.finalCues.map((cue) => [cue.sourceText, cue.translatedText]), [[
    'late source',
    'late translation'
  ]]);
});

test('late transcript, stop flush, rollover sequence, and replay remain deterministic', async () => {
  let cueState = createSubtitleCueState();
  let clock = 0;
  const onCueEvent = (event) => {
    cueState = applySubtitleCueEvent(cueState, event);
  };
  const createSession = (liveSessionId, segmentId) => new LiveTranslateSession({
    liveSessionId,
    segmentId,
    targetLanguageCode: 'en',
    echoTargetLanguage: true,
    sessionClock: () => (clock += 100),
    onCueEvent
  });

  const first = createSession('live-1', 'segment-1');
  first.handleMessage({ eventId: 'source-1', serverContent: { inputTranscription: { text: 'first source' } } });
  first.handleMessage({ eventId: 'turn-1', serverContent: { turnComplete: true } });
  first.handleMessage({ eventId: 'translation-1', serverContent: { outputTranscription: { text: 'first translation' } } });
  first.handleMessage({ eventId: 'source-1', serverContent: { inputTranscription: { text: 'first source' } } });

  const second = createSession('live-2', 'segment-2');
  second.handleMessage({ eventId: 'source-2', serverContent: { inputTranscription: { text: 'second source' } } });
  second.handleMessage({ eventId: 'translation-2', serverContent: { outputTranscription: { text: 'second translation' } } });
  cueState = finalizePendingSubtitleCue(cueState, { sessionTimeMs: clock + 500, reason: 'stop' });

  assert.equal(cueState.finalCues.length, 2);
  assert.deepEqual(cueState.finalCues.map((cue) => cue.sequence), [1, 2]);
  assert.ok(cueState.finalCues[1].startTimeMs > cueState.finalCues[0].endTimeMs);
  assert.equal(cueState.finalCues[0].sourceText, 'first source');
  assert.equal(cueState.finalCues[1].translatedText, 'second translation');
  await first.stop();
  await second.stop();
});

test('transcription mode finalizes source-only subtitles without translation pairing', () => {
  let cueState = createSubtitleCueState();
  const session = new LiveTranslateSession({
    mode: 'transcription',
    liveSessionId: 'live-transcription',
    sessionId: 'session-transcription',
    segmentId: 'segment-transcription',
    sourceLanguageCode: 'zh-Hant',
    sessionClock: () => 100,
    onCueEvent: (event) => {
      cueState = applySubtitleCueEvent(cueState, event);
    }
  });

  session.handleMessage({
    eventId: 'source-only',
    serverContent: { inputTranscription: { text: '只有來源字幕' } }
  });
  cueState = finalizePendingSubtitleCue(cueState, { sessionTimeMs: 500, reason: 'stop' });

  assert.equal(cueState.finalCues.length, 1);
  assert.equal(cueState.finalCues[0].sourceText, '只有來源字幕');
  assert.equal(cueState.finalCues[0].translatedText, '');
  assert.equal(cueState.finalCues[0].targetLanguageCode, null);
  assert.equal(cueState.finalCues[0].mode, 'transcription');
  assert.equal(cueState.finalCues[0].refinement, undefined);
});

test('LiveTranscriptionSession ignores translated output and audio callbacks', () => {
  const output = [];
  const audio = [];
  const session = new LiveTranscriptionSession({
    liveSessionId: 'live-transcription-output',
    sourceLanguageCode: 'en',
    sessionClock: () => 100,
    onOutputTranscript: (event) => output.push(event),
    onOutputAudioChunk: (chunk) => audio.push(chunk)
  });

  session.handleMessage({
    eventId: 'model-output',
    serverContent: {
      outputTranscription: { text: 'must be ignored' },
      modelTurn: { parts: [{ inlineData: { data: 'AA==' } }] }
    }
  });

  assert.deepEqual(output, []);
  assert.deepEqual(audio, []);
});
