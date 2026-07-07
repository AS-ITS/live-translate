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
    onClose
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
    this.audioContext = null;
    this.mediaStream = null;
    this.source = null;
    this.processor = null;
    this.session = null;
    this.chunker = null;
    this.nextPlaybackTime = 0;
    this.playbackSources = new Set();
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
      'Live translation took too long to connect. Please try again.'
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

    if (content?.inputTranscription?.text) {
      this.onInputTranscript?.({ text: content.inputTranscription.text, isFinal });
    }

    if (content?.outputTranscription?.text) {
      this.onOutputTranscript?.({ text: content.outputTranscription.text, isFinal });
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
    await this.cleanup({ closeSession: true, signalAudioEnd: true });
    this.onClose?.({ reason: 'user-stopped' });
  }

  async handleSessionError(event) {
    const message = event?.message || event?.error?.message || 'Live API error';
    await this.cleanup({ closeSession: true });
    this.onError?.(new Error(message));
  }

  async handleSessionClose(event) {
    if (this.closeExpected || this.closed) {
      return;
    }

    const reason = event?.reason ? `: ${event.reason}` : '';
    const code = event?.code ? ` (code ${event.code})` : '';
    await this.cleanup({ closeSession: false });
    this.onError?.(new Error(`Live API session closed unexpectedly${reason}${code}`));
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
      throw new Error('Live translation service took too long to respond. Please try again.');
    }
    throw new Error('Unable to reach the live translation service. Please try again.');
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

function userMessageForErrorCode(code) {
  const messages = {
    auth_required: 'Access is not configured for this demo. Please contact the operator.',
    auth_invalid: 'Access is not configured for this demo. Please contact the operator.',
    auth_not_configured: 'Live translation is not configured for production yet.',
    invalid_origin: 'This site is not allowed to request live translation.',
    provider_unavailable: 'Live translation provider is temporarily unavailable. Please try again.',
    rate_limited: 'Too many live translation starts. Please wait and try again.',
    server_misconfigured: 'Live translation is not configured on the server.',
    unsupported_language: 'The selected target language is not supported.',
    invalid_json: 'Live translation request could not be prepared.',
    request_too_large: 'Live translation request is too large.'
  };

  return messages[code] || 'Unable to start live translation. Please try again.';
}
