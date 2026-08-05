import { GoogleGenAI, Modality } from '@google/genai';
import {
  base64ToBytes,
  bytesToBase64,
  createPcmChunker,
  OUTPUT_SAMPLE_RATE,
  pcm16ToFloat
} from './audio.js';
import { applyGlossaryReplacements } from './glossaryReplacement.js';
import { buildAudioInputConstraints, isMissingSelectedInputError } from './mediaDevices.js';
import { normalizeGeminiLiveCueEvents } from './geminiLiveCueEvent.js';

const TOKEN_TIMEOUT_MS = 10000;
const LIVE_CONNECT_TIMEOUT_MS = 15000;
const DEMO_ACCESS_TOKEN = import.meta.env?.VITE_DEMO_ACCESS_TOKEN;
const LIVE_EVENT_LOG_ENABLED = Boolean(import.meta.env?.DEV);
const DEFAULT_SOURCE_LANGUAGE_CODE = 'zh-Hant';

export class LiveTranslateSession {
  constructor({
    targetLanguageCode,
    sourceLanguageCode = DEFAULT_SOURCE_LANGUAGE_CODE,
    echoTargetLanguage,
    inputDeviceId = '',
    onInputDeviceFallback,
    onMicrophoneReady,
    onConnecting,
    onInputAudioChunk,
    onInputTranscript,
    onOutputTranscript,
    onOutputAudioChunk,
    onError,
    onClose,
    onConnectionFailure,
    liveGlossaryEntries = [],
    liveSessionId = null,
    sessionId = null,
    segmentId = null,
    sessionClock = createDefaultSessionClock(),
    onCueEvent
  }) {
    this.targetLanguageCode = targetLanguageCode;
    this.sourceLanguageCode = sourceLanguageCode;
    this.echoTargetLanguage = echoTargetLanguage;
    this.inputDeviceId = inputDeviceId;
    this.onInputDeviceFallback = onInputDeviceFallback;
    this.onMicrophoneReady = onMicrophoneReady;
    this.onConnecting = onConnecting;
    this.onInputAudioChunk = onInputAudioChunk;
    this.onInputTranscript = onInputTranscript;
    this.onOutputTranscript = onOutputTranscript;
    this.onOutputAudioChunk = onOutputAudioChunk;
    this.onError = onError;
    this.onClose = onClose;
    this.onConnectionFailure = onConnectionFailure;
    this.liveGlossaryEntries = liveGlossaryEntries;
    this.liveSessionId = liveSessionId;
    this.sessionId = sessionId;
    this.segmentId = segmentId;
    this.sessionClock = sessionClock;
    this.onCueEvent = onCueEvent;
    this.eventSequence = 0;
    this.audioContext = null;
    this.mediaStream = null;
    this.source = null;
    this.processor = null;
    this.session = null;
    this.chunker = null;
    this.nextPlaybackTime = 0;
    this.playbackSources = new Set();
    this.pendingInputTranscript = null;
    this.pendingInputTranscriptFinalizableOnTurnComplete = false;
    this.pendingOutputTranscript = null;
    this.awaitingInputTranscriptAfterTurnComplete = false;
    this.awaitingOutputTranscriptAfterTurnComplete = false;
    this.closed = false;
    this.closeExpected = false;
    this.cleaningUp = false;
    this.retranslationCueIds = new Set();
  }

  async start() {
    this.mediaStream = await this.openInputStream();
    this.onMicrophoneReady?.({ mediaStream: this.mediaStream });

    this.audioContext = new AudioContext();
    this.chunker = createPcmChunker({ sourceRate: this.audioContext.sampleRate });
    this.onConnecting?.();

    const tokenResponse = await fetchWithTimeout('/api/live-token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(DEMO_ACCESS_TOKEN ? { 'X-Demo-Access-Token': DEMO_ACCESS_TOKEN } : {})
      },
      body: JSON.stringify({
        targetLanguageCode: this.targetLanguageCode,
        sourceLanguageCode: this.sourceLanguageCode,
        echoTargetLanguage: this.echoTargetLanguage
      })
    }, TOKEN_TIMEOUT_MS);

    if (!tokenResponse.ok) {
      const error = await tokenResponse.json().catch(() => ({ error: { code: 'token_request_failed' } }));
      throw new Error(userMessageForErrorCode(error.error?.code));
    }

    const { token, liveConnectModel, liveConnectConfig, liveGlossaryEntries } = await tokenResponse.json();
    this.liveGlossaryEntries = Array.isArray(liveGlossaryEntries) ? liveGlossaryEntries : [];
    const ai = new GoogleGenAI({
      apiKey: token,
      httpOptions: {
        apiVersion: 'v1alpha'
      }
    });

    this.session = await withTimeout(
      ai.live.connect({
        model: liveConnectModel || 'gemini-3.5-live-translate-preview',
        config: liveConnectConfig || {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          generationConfig: {
            translationConfig: {
              targetLanguageCode: this.targetLanguageCode,
              echoTargetLanguage: this.echoTargetLanguage
            }
          }
        },
        callbacks: {
          onmessage: (message) => this.handleMessage(message),
          onerror: (event) => {
            void this.handleSessionError(event);
          },
          onclose: (event) => {
            void this.handleSessionClose(event);
          }
        }
      }),
      LIVE_CONNECT_TIMEOUT_MS,
      '即時翻譯連線逾時。請再試一次。'
    );

    this.source = this.audioContext.createMediaStreamSource(this.mediaStream);
    // TODO: Replace ScriptProcessorNode with AudioWorklet for lower latency and non-deprecated capture.
    this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (event) => {
      if (this.closed || !this.session) {
        return;
      }

      const input = event.inputBuffer.getChannelData(0);
      const chunks = this.chunker.push(input);

      for (const chunk of chunks) {
        this.onInputAudioChunk?.(new Uint8Array(chunk));
        this.session.sendRealtimeInput({
          audio: {
            data: bytesToBase64(chunk),
            mimeType: 'audio/pcm;rate=16000'
          }
        });
      }
    };

    this.source.connect(this.processor);
    this.processor.connect(this.audioContext.destination);
  }

  async openInputStream() {
    try {
      return await navigator.mediaDevices.getUserMedia(buildAudioInputConstraints(this.inputDeviceId));
    } catch (error) {
      if (!this.inputDeviceId || !isMissingSelectedInputError(error)) {
        throw error;
      }

      this.inputDeviceId = '';
      this.onInputDeviceFallback?.();
      return navigator.mediaDevices.getUserMedia(buildAudioInputConstraints());
    }
  }

  retranslateSourceText(sourceText, cueId = '') {
    const text = String(sourceText || '').trim();
    const key = String(cueId || text);
    if (!text || this.closed || !this.session || this.retranslationCueIds.has(key)) return false;

    this.retranslationCueIds.add(key);
    try {
      this.session.sendClientContent({
        turns: [{
          role: 'user',
          parts: [{
            text: `Translate the following source text into ${this.targetLanguageCode}. Return only the translation, without explanation:\n${text}`
          }]
        }],
        turnComplete: true
      });
      return true;
    } catch (error) {
      this.retranslationCueIds.delete(key);
      this.logLiveEvent('retranslation.failed', { message: error?.message || 'sendClientContent failed' });
      return false;
    }
  }

  handleMessage(message) {
    const content = message.serverContent;
    const isFinal = Boolean(content?.turnComplete || content?.generationComplete);
    const inputTranscriptIsFinal = isFinal || this.awaitingInputTranscriptAfterTurnComplete;
    const outputTranscriptIsFinal = isFinal || this.awaitingOutputTranscriptAfterTurnComplete;
    this.eventSequence += 1;
    for (const event of normalizeGeminiLiveCueEvents(message, {
      liveSessionId: this.liveSessionId,
      sessionId: this.sessionId,
      segmentId: this.segmentId,
      sourceLanguageCode: this.sourceLanguageCode,
      targetLanguageCode: this.targetLanguageCode,
      eventSequence: this.eventSequence,
      sessionClock: this.sessionClock,
      inputTranscriptIsFinal,
      outputTranscriptIsFinal
    })) {
      this.onCueEvent?.(event);
    }
    this.logLiveEvent('message.received', {
      event: summarizeLiveEvent(message),
      stateBefore: this.transcriptBoundaryState()
    });

    if (content?.inputTranscription?.text) {
      const transcript = {
        text: content.inputTranscription.text,
        isFinal: isFinal || this.awaitingInputTranscriptAfterTurnComplete,
        ...(content.inputTranscription.sourceLanguageDetection === undefined
          ? {}
          : { sourceLanguageDetection: content.inputTranscription.sourceLanguageDetection })
      };
      this.logLiveEvent('inputTranscription.callback', { transcript });
      this.onInputTranscript?.(transcript);
      this.pendingInputTranscript = transcript.isFinal ? null : transcript;
      this.pendingInputTranscriptFinalizableOnTurnComplete = !transcript.isFinal;
      this.awaitingInputTranscriptAfterTurnComplete = false;
    } else if (content?.interimInputTranscription?.text) {
      const transcript = {
        text: content.interimInputTranscription.text,
        isFinal: false,
        ...(content.interimInputTranscription.sourceLanguageDetection === undefined
          ? {}
          : { sourceLanguageDetection: content.interimInputTranscription.sourceLanguageDetection })
      };
      this.logLiveEvent('interimInputTranscription.callback', { transcript });
      this.onInputTranscript?.(transcript);
      this.pendingInputTranscript = transcript;
      this.pendingInputTranscriptFinalizableOnTurnComplete = false;
    } else if (isFinal && this.pendingInputTranscript && this.pendingInputTranscriptFinalizableOnTurnComplete) {
      const transcript = { ...this.pendingInputTranscript, isFinal: true };
      this.logLiveEvent('inputTranscription.flushOnTurnComplete', { transcript });
      this.onInputTranscript?.(transcript);
      this.pendingInputTranscript = null;
      this.pendingInputTranscriptFinalizableOnTurnComplete = false;
    } else if (isFinal) {
      this.logLiveEvent('inputTranscription.awaitingLateText');
      this.awaitingInputTranscriptAfterTurnComplete = true;
    }

    if (content?.outputTranscription?.text) {
      const transcript = {
        text: applyGlossaryReplacements(content.outputTranscription.text, this.liveGlossaryEntries),
        isFinal: isFinal || this.awaitingOutputTranscriptAfterTurnComplete
      };
      this.logLiveEvent('outputTranscription.callback', { transcript });
      this.onOutputTranscript?.(transcript);
      this.pendingOutputTranscript = transcript.isFinal ? null : transcript;
      this.awaitingOutputTranscriptAfterTurnComplete = false;
    } else if (isFinal && this.pendingOutputTranscript) {
      const transcript = { ...this.pendingOutputTranscript, isFinal: true };
      this.logLiveEvent('outputTranscription.flushOnTurnComplete', { transcript });
      this.onOutputTranscript?.(transcript);
      this.pendingOutputTranscript = null;
    } else if (isFinal) {
      this.logLiveEvent('outputTranscription.awaitingLateText');
      this.awaitingOutputTranscriptAfterTurnComplete = true;
    }

    if (content?.interrupted) {
      this.clearPlaybackQueue();
    }

    const parts = content?.modelTurn?.parts || [];
    for (const part of parts) {
      if (part.inlineData?.data) {
        this.playPcmAudio(part.inlineData.data);
      }
    }

    this.logLiveEvent('message.processed', {
      stateAfter: this.transcriptBoundaryState()
    });
  }

  playPcmAudio(base64Audio) {
    if (!this.audioContext) {
      return;
    }

    const bytes = base64ToBytes(base64Audio);
    this.onOutputAudioChunk?.(new Uint8Array(bytes));
    const samples = pcm16ToFloat(bytes);
    const buffer = this.audioContext.createBuffer(1, samples.length, OUTPUT_SAMPLE_RATE);
    buffer.copyToChannel(samples, 0);

    const source = this.audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(this.audioContext.destination);
    source.onended = () => {
      this.playbackSources.delete(source);
    };

    const now = this.audioContext.currentTime;
    this.nextPlaybackTime = Math.max(now, this.nextPlaybackTime);
    this.playbackSources.add(source);
    source.start(this.nextPlaybackTime);
    this.nextPlaybackTime += buffer.duration;
  }

  async stop() {
    this.closeExpected = true;
    this.flushPendingTranscripts();
    await this.cleanup({ closeSession: true, signalAudioEnd: true });
    this.onClose?.({ reason: 'user-stopped' });
  }

  async handleSessionError(event) {
    const message = event?.message || event?.error?.message || 'Live API error';
    const error = event instanceof Error ? event : new Error(message);
    this.flushPendingTranscripts();
    await this.cleanup({ closeSession: true });
    this.onConnectionFailure?.({
      source: 'live_error',
      rawError: error,
      rawEvent: event,
      reasonHint: 'provider_error',
      afterCleanup: true
    });
    this.onError?.(error);
  }

  async handleSessionClose(event) {
    if (this.closeExpected || this.closed) {
      return;
    }

    const reason = event?.reason ? `: ${event.reason}` : '';
    const code = event?.code ? ` (code ${event.code})` : '';
    const error = new Error(`Live API session closed unexpectedly${reason}${code}`);
    this.flushPendingTranscripts();
    await this.cleanup({ closeSession: false });
    this.onConnectionFailure?.({
      source: 'unexpected_close',
      rawError: error,
      rawEvent: event,
      reasonHint: 'unexpected_close',
      afterCleanup: true
    });
    this.onError?.(error);
  }

  flushPendingTranscripts() {
    this.flushPendingTranscript('input');
    this.flushPendingTranscript('output');
  }

  flushPendingTranscript(kind) {
    const isInput = kind === 'input';
    const pendingKey = isInput ? 'pendingInputTranscript' : 'pendingOutputTranscript';
    const awaitingKey = isInput
      ? 'awaitingInputTranscriptAfterTurnComplete'
      : 'awaitingOutputTranscriptAfterTurnComplete';
    const callback = isInput ? this.onInputTranscript : this.onOutputTranscript;
    const pending = this[pendingKey];

    if (pending) {
      const transcript = { ...pending, isFinal: true };
      this.logLiveEvent(`${kind}Transcription.flushPending`, { transcript });
      callback?.(transcript);
      this[pendingKey] = null;
    }

    this[awaitingKey] = false;
    if (isInput) {
      this.pendingInputTranscriptFinalizableOnTurnComplete = false;
    }
  }

  transcriptBoundaryState() {
    return {
      pendingInputText: this.pendingInputTranscript?.text || '',
      pendingOutputText: this.pendingOutputTranscript?.text || '',
      pendingInputTranscriptFinalizableOnTurnComplete: this.pendingInputTranscriptFinalizableOnTurnComplete,
      awaitingInputTranscriptAfterTurnComplete: this.awaitingInputTranscriptAfterTurnComplete,
      awaitingOutputTranscriptAfterTurnComplete: this.awaitingOutputTranscriptAfterTurnComplete
    };
  }

  logLiveEvent(stage, details = {}) {
    if (!LIVE_EVENT_LOG_ENABLED) {
      return;
    }

    console.debug('[Gemini Live event]', {
      stage,
      ...details
    });
  }

  async cleanup({ closeSession = true, signalAudioEnd = false } = {}) {
    if (this.cleaningUp) {
      return;
    }

    this.cleaningUp = true;
    try {
      this.closed = true;
      this.chunker?.reset();
      this.clearPlaybackQueue();

      if (signalAudioEnd) {
        try {
          this.session?.sendRealtimeInput({ audioStreamEnd: true });
        } catch {
          // The session may already be closed.
        }
      }

      if (this.processor) {
        this.processor.onaudioprocess = null;
      }

      try {
        this.processor?.disconnect();
      } catch {
        // Audio nodes may already be disconnected during error cleanup.
      }

      try {
        this.source?.disconnect();
      } catch {
        // Audio nodes may already be disconnected during error cleanup.
      }

      this.mediaStream?.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {
          // Media tracks may already be stopped by the browser.
        }
      });

      if (closeSession) {
        try {
          this.session?.close();
        } catch {
          // Closing is best-effort during cleanup.
        }
      }

      if (this.audioContext && this.audioContext.state !== 'closed') {
        try {
          await this.audioContext.close();
        } catch {
          // Closing AudioContext is best-effort during browser teardown.
        }
      }

      this.processor = null;
      this.source = null;
      this.mediaStream = null;
      this.session = null;
      this.audioContext = null;
      this.chunker = null;
      this.pendingInputTranscript = null;
      this.pendingInputTranscriptFinalizableOnTurnComplete = false;
      this.pendingOutputTranscript = null;
      this.awaitingInputTranscriptAfterTurnComplete = false;
      this.awaitingOutputTranscriptAfterTurnComplete = false;
      this.nextPlaybackTime = 0;
    } finally {
      this.cleaningUp = false;
    }
  }

  clearPlaybackQueue() {
    for (const source of this.playbackSources) {
      try {
        source.stop();
      } catch {
        // Already ended or stopped.
      }
      try {
        source.disconnect();
      } catch {
        // Already disconnected.
      }
      source.onended = null;
    }

    this.playbackSources.clear();
    this.nextPlaybackTime = this.audioContext?.currentTime || 0;
  }
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('即時翻譯服務回應逾時。請再試一次。');
    }
    throw new Error('無法連線至即時翻譯服務。請再試一次。');
  } finally {
    clearTimeout(timeoutId);
  }
}

function withTimeout(promise, timeoutMs, message) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

function summarizeLiveEvent(message) {
  const content = message?.serverContent;
  const parts = content?.modelTurn?.parts || [];

  return {
    topLevelKeys: objectKeys(message),
    serverContentKeys: objectKeys(content),
    turnComplete: Boolean(content?.turnComplete),
    generationComplete: Boolean(content?.generationComplete),
    interrupted: Boolean(content?.interrupted),
    inputTranscriptionText: content?.inputTranscription?.text || '',
    interimInputTranscriptionText: content?.interimInputTranscription?.text || '',
    outputTranscriptionText: content?.outputTranscription?.text || '',
    inputTranscriptionKeys: objectKeys(content?.inputTranscription),
    interimInputTranscriptionKeys: objectKeys(content?.interimInputTranscription),
    outputTranscriptionKeys: objectKeys(content?.outputTranscription),
    modelTurnPartCount: parts.length,
    inlineAudioPartCount: parts.filter((part) => part.inlineData?.data).length
  };
}

function objectKeys(value) {
  return value && typeof value === 'object' ? Object.keys(value) : [];
}

function createDefaultSessionClock() {
  const startedAt = typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : 0;
  return () => {
    const now = typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : 0;
    return Math.max(0, now - startedAt);
  };
}

function userMessageForErrorCode(code) {
  const messages = {
    auth_required: '此示範尚未設定存取權限。請聯絡管理員。',
    auth_invalid: '此示範尚未設定存取權限。請聯絡管理員。',
    auth_not_configured: '正式環境尚未設定即時翻譯。',
    invalid_origin: '此網站不允許請求即時翻譯。',
    provider_unavailable: '即時翻譯服務暫時無法使用。請再試一次。',
    rate_limited: '開始即時翻譯的請求過於頻繁。請稍候再試。',
    server_misconfigured: '伺服器尚未設定即時翻譯。',
    unsupported_language: '不支援所選的目標語言。',
    invalid_json: '無法準備即時翻譯請求。',
    request_too_large: '即時翻譯請求過大。'
  };

  return messages[code] || '無法開始即時翻譯。請再試一次。';
}
