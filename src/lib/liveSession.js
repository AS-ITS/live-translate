import { GoogleGenAI, Modality } from '@google/genai';
import {
  base64ToBytes,
  bytesToBase64,
  createPcmChunker,
  OUTPUT_SAMPLE_RATE,
  pcm16ToFloat
} from './audio.js';
import { buildAudioInputConstraints, isMissingSelectedInputError } from './mediaDevices.js';

const TOKEN_TIMEOUT_MS = 10000;
const LIVE_CONNECT_TIMEOUT_MS = 15000;
const DEMO_ACCESS_TOKEN = import.meta.env?.VITE_DEMO_ACCESS_TOKEN;
const LIVE_EVENT_LOG_ENABLED = Boolean(import.meta.env?.DEV);

export class LiveTranslateSession {
  constructor({
    targetLanguageCode,
    echoTargetLanguage,
    inputDeviceId = '',
    onInputDeviceFallback,
    onMicrophoneReady,
    onConnecting,
    onInputTranscript,
    onOutputTranscript,
    onError,
    onClose,
    onConnectionFailure
  }) {
    this.targetLanguageCode = targetLanguageCode;
    this.echoTargetLanguage = echoTargetLanguage;
    this.inputDeviceId = inputDeviceId;
    this.onInputDeviceFallback = onInputDeviceFallback;
    this.onMicrophoneReady = onMicrophoneReady;
    this.onConnecting = onConnecting;
    this.onInputTranscript = onInputTranscript;
    this.onOutputTranscript = onOutputTranscript;
    this.onError = onError;
    this.onClose = onClose;
    this.onConnectionFailure = onConnectionFailure;
    this.audioContext = null;
    this.mediaStream = null;
    this.source = null;
    this.processor = null;
    this.session = null;
    this.chunker = null;
    this.nextPlaybackTime = 0;
    this.playbackSources = new Set();
    this.pendingInputTranscript = null;
    this.pendingOutputTranscript = null;
    this.awaitingInputTranscriptAfterTurnComplete = false;
    this.awaitingOutputTranscriptAfterTurnComplete = false;
    this.closed = false;
    this.closeExpected = false;
    this.cleaningUp = false;
  }

  async start() {
    this.mediaStream = await this.openInputStream();
    this.onMicrophoneReady?.();

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
        echoTargetLanguage: this.echoTargetLanguage
      })
    }, TOKEN_TIMEOUT_MS);

    if (!tokenResponse.ok) {
      const error = await tokenResponse.json().catch(() => ({ error: { code: 'token_request_failed' } }));
      throw new Error(userMessageForErrorCode(error.error?.code));
    }

    const { token } = await tokenResponse.json();
    const ai = new GoogleGenAI({
      apiKey: token,
      httpOptions: {
        apiVersion: 'v1alpha'
      }
    });

    this.session = await withTimeout(
      ai.live.connect({
        model: 'gemini-3.5-live-translate-preview',
        config: {
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

  handleMessage(message) {
    const content = message.serverContent;
    const isFinal = Boolean(content?.turnComplete || content?.generationComplete);
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
      this.awaitingInputTranscriptAfterTurnComplete = false;
    } else if (isFinal && this.pendingInputTranscript) {
      const transcript = { ...this.pendingInputTranscript, isFinal: true };
      this.logLiveEvent('inputTranscription.flushOnTurnComplete', { transcript });
      this.onInputTranscript?.(transcript);
      this.pendingInputTranscript = null;
    } else if (isFinal) {
      this.logLiveEvent('inputTranscription.awaitingLateText');
      this.awaitingInputTranscriptAfterTurnComplete = true;
    }

    if (content?.outputTranscription?.text) {
      const transcript = {
        text: content.outputTranscription.text,
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
  }

  transcriptBoundaryState() {
    return {
      pendingInputText: this.pendingInputTranscript?.text || '',
      pendingOutputText: this.pendingOutputTranscript?.text || '',
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

    this.mediaStream?.getTracks().forEach((track) => track.stop());

    if (closeSession) {
      try {
        this.session?.close();
      } catch {
        // Closing is best-effort during cleanup.
      }
    }

    if (this.audioContext && this.audioContext.state !== 'closed') {
      await this.audioContext.close();
    }

    this.processor = null;
    this.source = null;
    this.mediaStream = null;
    this.session = null;
    this.audioContext = null;
    this.cleaningUp = false;
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
    outputTranscriptionText: content?.outputTranscription?.text || '',
    inputTranscriptionKeys: objectKeys(content?.inputTranscription),
    outputTranscriptionKeys: objectKeys(content?.outputTranscription),
    modelTurnPartCount: parts.length,
    inlineAudioPartCount: parts.filter((part) => part.inlineData?.data).length
  };
}

function objectKeys(value) {
  return value && typeof value === 'object' ? Object.keys(value) : [];
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
