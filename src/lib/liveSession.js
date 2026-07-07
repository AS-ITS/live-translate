import { GoogleGenAI, Modality } from '@google/genai';
import {
  base64ToBytes,
  bytesToBase64,
  createPcmChunker,
  OUTPUT_SAMPLE_RATE,
  pcm16ToFloat
} from './audio.js';

export class LiveTranslateSession {
  constructor({ targetLanguageCode, echoTargetLanguage, onInputTranscript, onOutputTranscript, onError, onClose }) {
    this.targetLanguageCode = targetLanguageCode;
    this.echoTargetLanguage = echoTargetLanguage;
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
    this.closed = false;
  }

  async start() {
    const tokenResponse = await fetch('/api/live-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetLanguageCode: this.targetLanguageCode,
        echoTargetLanguage: this.echoTargetLanguage
      })
    });

    if (!tokenResponse.ok) {
      const error = await tokenResponse.json().catch(() => ({ error: 'Token request failed' }));
      throw new Error(error.error || 'Token request failed');
    }

    const { token } = await tokenResponse.json();
    const ai = new GoogleGenAI({ apiKey: token });

    this.audioContext = new AudioContext();
    this.chunker = createPcmChunker({ sourceRate: this.audioContext.sampleRate });

    this.session = await ai.live.connect({
      model: 'gemini-3.5-live-translate-preview',
      config: {
        responseModalities: [Modality.AUDIO],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        translationConfig: {
          targetLanguageCode: this.targetLanguageCode,
          echoTargetLanguage: this.echoTargetLanguage
        }
      },
      callbacks: {
        onmessage: (message) => this.handleMessage(message),
        onerror: (event) => this.onError?.(new Error(event.message || 'Live API error')),
        onclose: () => this.onClose?.()
      }
    });

    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1
      }
    });

    this.source = this.audioContext.createMediaStreamSource(this.mediaStream);
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

  handleMessage(message) {
    const content = message.serverContent;

    if (content?.inputTranscription?.text) {
      this.onInputTranscript?.(content.inputTranscription.text);
    }

    if (content?.outputTranscription?.text) {
      this.onOutputTranscript?.(content.outputTranscription.text);
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

    const now = this.audioContext.currentTime;
    this.nextPlaybackTime = Math.max(now, this.nextPlaybackTime);
    source.start(this.nextPlaybackTime);
    this.nextPlaybackTime += buffer.duration;
  }

  async stop() {
    this.closed = true;
    this.chunker?.reset();
    this.processor?.disconnect();
    this.source?.disconnect();
    this.mediaStream?.getTracks().forEach((track) => track.stop());
    this.session?.close();

    if (this.audioContext && this.audioContext.state !== 'closed') {
      await this.audioContext.close();
    }
  }
}

