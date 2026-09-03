import { GoogleGenAI, Modality } from '@google/genai';
import {
  base64ToBytes,
  bytesToBase64,
  createPcmChunker,
  OUTPUT_SAMPLE_RATE,
  pcm16ToFloat
} from './audio.js';
import { applyGlossaryReplacements } from './glossaryReplacement.js';
import { isMissingSelectedInputError, requestAudioInputStream } from './mediaDevices.js';
import { normalizeGeminiLiveCueEvents } from './geminiLiveCueEvent.js';
import { authenticatedFetch } from './accessToken.js';

const TOKEN_TIMEOUT_MS = 10000;
const LIVE_CONNECT_TIMEOUT_MS = 15000;
const MAX_PENDING_INPUT_AUDIO_CHUNKS = 64;
const MAX_PRE_ROLL_BYTES = 480000;
const AUDIO_CALLBACK_STALL_MS = 3000;
const LOCAL_SILENCE_FINALIZE_MS = 1800;
const TOKEN_REFRESH_SAFETY_MS = 5 * 60 * 1000;
const SPEECH_ACTIVITY_RMS_THRESHOLD = 0.01;
const LIVE_EVENT_LOG_ENABLED = Boolean(import.meta.env?.DEV);
const DEFAULT_SOURCE_LANGUAGE_CODE = 'zh-Hant';
let nextAudioTurnSequence = 0;
let activeDebugSession = null;

export class LiveTranslateSession {
  constructor({
    targetLanguageCode,
    sourceLanguageCode = DEFAULT_SOURCE_LANGUAGE_CODE,
    echoTargetLanguage,
    inputDeviceId = '',
    microphonePermissionTimeoutMs,
    onInputDeviceFallback,
    onMicrophoneReady,
    onCaptureStateChange,
    onProviderReady,
    onConnecting,
    onInputAudioChunk,
    onInputTranscript,
    onOutputTranscript,
    onOutputAudioChunk,
    onError,
    onClose,
    onConnectionFailure,
    liveGlossaryEntries = [],
    meetingId = null,
    liveSessionId = null,
    sessionId = null,
    segmentId = null,
    sessionClock = createDefaultSessionClock(),
    onCueEvent,
    authorizationHeaders = {},
    connectionEpoch = 0,
    audioTurnId = null,
    silenceFinalizeMs = LOCAL_SILENCE_FINALIZE_MS,
    speechActivityRmsThreshold = SPEECH_ACTIVITY_RMS_THRESHOLD
    , mode = 'translation'
  }) {
    this.mode = mode;
    this.targetLanguageCode = targetLanguageCode;
    this.sourceLanguageCode = sourceLanguageCode;
    this.echoTargetLanguage = echoTargetLanguage;
    this.inputDeviceId = inputDeviceId;
    this.microphonePermissionTimeoutMs = microphonePermissionTimeoutMs;
    this.onInputDeviceFallback = onInputDeviceFallback;
    this.onMicrophoneReady = onMicrophoneReady;
    this.onCaptureStateChange = onCaptureStateChange;
    this.onProviderReady = onProviderReady;
    this.onConnecting = onConnecting;
    this.onInputAudioChunk = onInputAudioChunk;
    this.onInputTranscript = onInputTranscript;
    this.onOutputTranscript = onOutputTranscript;
    this.onOutputAudioChunk = onOutputAudioChunk;
    this.onError = onError;
    this.onClose = onClose;
    this.onConnectionFailure = onConnectionFailure;
    this.liveGlossaryEntries = liveGlossaryEntries;
    this.meetingId = meetingId;
    this.liveSessionId = liveSessionId;
    this.sessionId = sessionId;
    this.segmentId = segmentId;
    this.sessionClock = sessionClock;
    this.onCueEvent = onCueEvent;
    this.authorizationHeaders = { ...authorizationHeaders };
    this.connectionEpoch = connectionEpoch;
    this.providerEpoch = 0;
    this.audioTurnId = audioTurnId || `audio-turn-${connectionEpoch}-${++nextAudioTurnSequence}`;
    this.silenceFinalizeMs = silenceFinalizeMs;
    this.speechActivityRmsThreshold = speechActivityRmsThreshold;
    this.inputSendingEnabled = false;
    this.captureEnabled = false;
    this.preRollDraining = false;
    this.providerReady = false;
    this.audioGraphEpoch = null;
    this.firstPcmChunkSent = false;
    this.eventSequence = 0;
    this.traceSequence = 0;
    this.providerFirstServerEventSeen = false;
    this.audioCallbackCount = 0;
    this.pcmGeneratedCount = 0;
    this.pcmGeneratedBytes = 0;
    this.pcmSendAttemptCount = 0;
    this.pcmSendAcceptedCount = 0;
    this.pcmSendSyncThrowCount = 0;
    this.pcmSendAsyncRejectCount = 0;
    this.firstPcmGeneratedAt = null;
    this.firstPcmSendAttemptAt = null;
    this.lastPcmGeneratedAt = null;
    this.lastPcmSendAt = null;
    this.lastAudioStreamEnd = null;
    this.lastInputEnd = null;
    this.failureDiagnostics = [];
    this.cueStateOwner = 'live-session';
    this.lastCueTransitionReason = null;
    this.audioContext = null;
    this.mediaStream = null;
    this.source = null;
    this.processor = null;
    this.session = null;
    this.chunker = null;
    this.pendingInputAudioChunks = [];
    this.pendingInputAudioBytes = 0;
    this.audioChunkSequence = 0;
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
    this.microphoneTrackListeners = [];
    this.microphoneFailureSignaled = false;
    this.inputTransportFailureSignaled = false;
    this.lastAudioCallbackAt = null;
    this.lastSpeechActivityAt = null;
    this.silenceFinalizeTimer = null;
    this.localTurnFinalizeTriggered = false;
    this.audioContextStateHandler = null;
    this.captureHealthTimer = null;
    this.captureRecoveryCount = 0;
    this.captureStartedAt = null;
    this.retranslationCueIds = new Set();
    this.activeRetranslationCueId = null;
    this.inputTurnMode = 'automatic';
    this.tokenState = null;
    this.resumptionHandle = null;
    this.providerReconnectInProgress = null;
    this.providerReconnectAttempts = 0;
    this.providerReconnectTimer = null;
    activeDebugSession = this;
    exposeLiveTranslateDebug();
  }

  async start({ inputStream = null } = {}) {
    this.trace('connect.invoked');
    this.mediaStream = inputStream || await this.openInputStream();
    this.attachMicrophoneTrackListeners();
    this.logLiveEvent('mic.ready', { connectionEpoch: this.connectionEpoch, sessionId: this.liveSessionId });
    this.onMicrophoneReady?.({ mediaStream: this.mediaStream });

    this.audioContext = createAudioContext();
    if (!await this.ensureAudioContextRunning()) return;
    this.chunker = createPcmChunker({ sourceRate: this.audioContext.sampleRate });
    this.setupAudioCapture();
    this.onCaptureStateChange?.({ state: 'capturing', connectionEpoch: this.connectionEpoch });

    this.onConnecting?.();

    await this.connectProvider();
  }

  async getTokenResponse({ forceRefresh = false } = {}) {
    const expiresAt = this.tokenState?.expiresAt ? Date.parse(this.tokenState.expiresAt) : 0;
    if (!forceRefresh && this.tokenState && expiresAt - Date.now() > TOKEN_REFRESH_SAFETY_MS) return this.tokenState;
    const tokenResponse = await fetchWithTimeout('/api/live-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authorizationHeaders },
      body: JSON.stringify({
        mode: this.mode,
        ...(this.sessionId ? { sessionId: this.sessionId } : {}),
        ...(this.meetingId ? { meetingId: this.meetingId } : {}),
        targetLanguageCode: this.targetLanguageCode,
        sourceLanguageCode: this.sourceLanguageCode,
        echoTargetLanguage: this.echoTargetLanguage
      })
    }, TOKEN_TIMEOUT_MS);
    if (!tokenResponse.ok) {
      const error = await tokenResponse.json().catch(() => ({ error: { code: 'token_request_failed' } }));
      throw new Error(userMessageForErrorCode(error.error?.code));
    }
    const response = await tokenResponse.json();
    this.tokenState = { ...response, fetchedAt: Date.now() };
    this.liveGlossaryEntries = Array.isArray(response.liveGlossaryEntries) ? response.liveGlossaryEntries : [];
    return this.tokenState;
  }

  async connectProvider({ forceRefresh = false } = {}) {
    const { token, liveConnectModel, liveConnectConfig } = await this.getTokenResponse({ forceRefresh });
    const ai = new GoogleGenAI({ apiKey: token, httpOptions: { apiVersion: 'v1alpha' } });
    const connectionEpoch = this.connectionEpoch;
    const providerEpoch = ++this.providerEpoch;
    const config = {
      ...(liveConnectConfig || {}),
      ...(this.resumptionHandle ? { sessionResumption: { handle: this.resumptionHandle } } : {})
    };
    this.inputTurnMode = config?.realtimeInputConfig?.automaticActivityDetection?.disabled ? 'manual' : 'automatic';
    const connectedSession = await withTimeout(ai.live.connect({
      model: liveConnectModel || 'gemini-3.5-live-translate-preview',
      config,
      callbacks: {
        onmessage: (message) => this.handleMessage(message, providerEpoch),
        onerror: (event) => { void this.handleSessionError(event, providerEpoch); },
        onclose: (event) => { void this.handleSessionClose(event, providerEpoch); }
      }
    }), LIVE_CONNECT_TIMEOUT_MS, '即時翻譯連線逾時。請再試一次。');
    if (this.closed || this.connectionEpoch !== connectionEpoch || this.providerEpoch !== providerEpoch) {
      try { connectedSession?.close?.(); } catch { /* stale provider session */ }
      return false;
    }
    this.session = connectedSession;
    this.trace('connect.resolved');
    this.logLiveEvent('provider.ready', { connectionEpoch: this.connectionEpoch, sessionId: this.liveSessionId });
    this.providerReady = true;
    this.preRollDraining = true;
    this.inputSendingEnabled = false;
    if (!this.drainPreRoll(connectionEpoch)) return false;
    this.preRollDraining = false;
    this.inputSendingEnabled = true;
    this.onProviderReady?.({ connectionEpoch: this.connectionEpoch });
    return true;
  }

  async reconnectProvider({ segmentId = this.segmentId, forceRefresh = false } = {}) {
    if (this.closed) return false;
    if (this.providerReconnectInProgress) return this.providerReconnectInProgress;
    this.segmentId = segmentId;
    this.providerReconnectInProgress = (async () => {
      this.providerReady = false;
      this.inputSendingEnabled = false;
      try { this.session?.close?.(); } catch { /* best effort */ }
      this.session = null;
      this.providerEpoch += 1;
      const result = await this.connectProvider({ forceRefresh });
      if (result) this.providerReconnectAttempts = 0;
      else this.providerReconnectAttempts += 1;
      return result;
    })().finally(() => { this.providerReconnectInProgress = null; });
    return this.providerReconnectInProgress;
  }

  setupAudioCapture() {
    if (!this.audioContext || !this.mediaStream) return false;
    this.disconnectAudioGraph();
    const captureEpoch = this.connectionEpoch;
    this.source = this.audioContext.createMediaStreamSource(this.mediaStream);
    // TODO: Replace ScriptProcessorNode with AudioWorklet for lower latency and non-deprecated capture.
    this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);
    const processor = this.processor;
    this.audioGraphEpoch = captureEpoch;
    this.captureEnabled = true;
    this.captureStartedAt = Date.now();
    this.lastAudioCallbackAt = null;
    this.captureRecoveryCount = 0;
    this.trace('capture_started');
    this.logLiveEvent('audio.graph.attached', { connectionEpoch: this.connectionEpoch, sessionId: this.liveSessionId });
    this.processor.onaudioprocess = (event) => {
      this.audioCallbackCount += 1;
      this.lastAudioCallbackAt = Date.now();
      if (this.audioCallbackCount === 1) this.trace('audio.callback.first');
      if (!this.isCurrentCaptureEpoch(captureEpoch, processor) || !this.chunker) {
        if (this.closed || captureEpoch !== this.connectionEpoch) this.trace('stale.callback.ignored', { kind: 'audio' });
        return;
      }

      // Count only consecutive stalls. A later healthy callback means the
      // browser capture graph recovered from a transient scheduling pause.
      this.captureRecoveryCount = 0;

      const input = event.inputBuffer.getChannelData(0);
      this.trackSpeechActivity(input);
      const chunks = this.chunker.push(input);

      for (const chunk of chunks) {
        this.sendInputAudioChunk(chunk, captureEpoch);
      }
    };

    this.source.connect(this.processor);
    this.processor.connect(this.audioContext.destination);
    this.audioContext?.removeEventListener?.('statechange', this.audioContextStateHandler);
    this.audioContextStateHandler = () => {
      if (this.closed || !this.audioContext) return;
      if (this.audioContext.state === 'suspended') void this.ensureAudioContextRunning();
      if (this.audioContext.state === 'closed') void this.handleAudioCaptureFailure('audio_context_lost', '瀏覽器音訊工作階段已停止。');
    };
    this.audioContext.addEventListener?.('statechange', this.audioContextStateHandler);
    if (this.captureHealthTimer) clearInterval(this.captureHealthTimer);
    this.captureHealthTimer = setInterval(() => { void this.checkAudioCaptureHealth(); }, 1000);
    this.captureHealthTimer?.unref?.();
    return true;
  }

  trackSpeechActivity(samples) {
    if (!samples?.length || this.closed) return false;
    let sumSquares = 0;
    for (const sample of samples) sumSquares += sample * sample;
    const rms = Math.sqrt(sumSquares / samples.length);
    if (rms < this.speechActivityRmsThreshold) return false;

    this.lastSpeechActivityAt = Date.now();
    this.localTurnFinalizeTriggered = false;
    this.scheduleSilenceFinalize();
    return true;
  }

  scheduleSilenceFinalize() {
    if (this.silenceFinalizeTimer) clearTimeout(this.silenceFinalizeTimer);
    if (this.closed || !this.lastSpeechActivityAt || this.silenceFinalizeMs < 0) return;
    const elapsed = Date.now() - this.lastSpeechActivityAt;
    const remaining = Math.max(0, this.silenceFinalizeMs - elapsed);
    this.silenceFinalizeTimer = setTimeout(() => {
      this.silenceFinalizeTimer = null;
      const silenceDuration = Date.now() - (this.lastSpeechActivityAt || Date.now());
      if (silenceDuration < this.silenceFinalizeMs) {
        this.scheduleSilenceFinalize();
        return;
      }
      this.localFinalizePendingTranscripts();
    }, remaining);
    this.silenceFinalizeTimer?.unref?.();
  }

  clearSilenceFinalizeTimer() {
    if (this.silenceFinalizeTimer) clearTimeout(this.silenceFinalizeTimer);
    this.silenceFinalizeTimer = null;
    this.lastSpeechActivityAt = null;
  }

  localFinalizePendingTranscripts() {
    if (this.closed || this.localTurnFinalizeTriggered) return false;
    if (!this.pendingInputTranscript && !this.pendingOutputTranscript) return false;

    const hadPendingInput = Boolean(this.pendingInputTranscript);
    const hadPendingOutput = Boolean(this.pendingOutputTranscript);
    this.localTurnFinalizeTriggered = true;
    this.clearSilenceFinalizeTimer();
    this.flushPendingTranscripts({ localFinalize: true });
    // Keep the late-transcript repair path open without sending a provider
    // boundary that could interfere with the next continuous recording turn.
    this.awaitingInputTranscriptAfterTurnComplete = hadPendingInput;
    this.awaitingOutputTranscriptAfterTurnComplete = hadPendingOutput;
    this.logLiveEvent('transcripts.finalized locally', {
      connectionEpoch: this.connectionEpoch,
      sessionId: this.liveSessionId,
      silenceMs: this.silenceFinalizeMs
    });
    return true;
  }

  async checkAudioCaptureHealth(now = Date.now()) {
    if (this.closed || !this.captureEnabled || !this.audioContext) return false;
    const lastCallbackAt = this.lastAudioCallbackAt || this.captureStartedAt;
    if (!lastCallbackAt || now - lastCallbackAt < AUDIO_CALLBACK_STALL_MS) return true;
    if (this.captureRecoveryCount < 1) {
      this.captureRecoveryCount += 1;
      this.trace('audio.callback.stalled', { recoveryCount: this.captureRecoveryCount });
      return this.recoverAudioCapture();
    }
    await this.handleAudioCaptureFailure('audio_capture_failed', '麥克風沒有產生音訊。請檢查麥克風後再試一次。');
    return false;
  }

  async ensureAudioContextRunning() {
    if (!this.audioContext) return false;
    if (this.audioContext.state === 'closed') {
      await this.handleAudioCaptureFailure('audio_context_lost', '瀏覽器音訊工作階段已停止。');
      return false;
    }
    if (this.audioContext.state === 'suspended' && typeof this.audioContext.resume === 'function') {
      try {
        await this.audioContext.resume();
      } catch (error) {
        await this.handleAudioCaptureFailure('audio_context_lost', error?.message || '瀏覽器音訊工作階段無法恢復。');
        return false;
      }
    }
    return this.audioContext.state === undefined || this.audioContext.state === 'running';
  }

  disconnectAudioGraph() {
    try { this.processor?.disconnect(); } catch { /* already disconnected */ }
    try { this.source?.disconnect(); } catch { /* already disconnected */ }
    if (this.processor) this.processor.onaudioprocess = null;
    this.processor = null;
    this.source = null;
    this.audioGraphEpoch = null;
  }

  async recoverAudioCapture() {
    if (this.closed || !this.mediaStream || !this.audioContext) return false;
    if (!await this.ensureAudioContextRunning()) return false;
    return this.setupAudioCapture();
  }

  queuePendingInputAudioChunk(chunk) {
    if (!chunk || chunk.byteLength === 0) return;
    const bytes = chunk instanceof Uint8Array ? new Uint8Array(chunk) : new Uint8Array(chunk);
    const record = {
      connectionEpoch: this.connectionEpoch,
      audioTurnId: this.audioTurnId,
      sequence: ++this.audioChunkSequence,
      timestamp: monotonicTimestamp(),
      bytes
    };
    while (
      this.pendingInputAudioChunks.length >= MAX_PENDING_INPUT_AUDIO_CHUNKS
      || this.pendingInputAudioBytes + bytes.byteLength > MAX_PRE_ROLL_BYTES
    ) {
      const dropped = this.pendingInputAudioChunks.shift();
      if (!dropped) break;
      this.pendingInputAudioBytes -= dropped.bytes.byteLength;
      this.trace('pre_roll_overflow', {
        droppedSequence: dropped.sequence,
        droppedBytes: dropped.bytes.byteLength,
        bufferedBytes: this.pendingInputAudioBytes
      });
    }
    this.pendingInputAudioChunks.push(record);
    this.pendingInputAudioBytes += bytes.byteLength;
    this.trace('pre_roll_enqueued', {
      sequence: record.sequence,
      bytes: bytes.byteLength,
      bufferedBytes: this.pendingInputAudioBytes
    });
  }

  flushPendingInputAudio(epoch = this.connectionEpoch) {
    return this.drainPreRoll(epoch);
  }

  sendInputAudioChunk(chunk, epoch = this.connectionEpoch, { force = false } = {}) {
    if ((!force
      && !this.isCurrentCaptureEpoch(epoch)
      && !this.isCurrentProviderInputEpoch(epoch)) || !chunk || chunk.byteLength === 0) return;
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    const generatedAt = nowIso();
    this.pcmGeneratedCount += 1;
    this.pcmGeneratedBytes += bytes.byteLength;
    this.firstPcmGeneratedAt ||= generatedAt;
    this.lastPcmGeneratedAt = generatedAt;
    const record = {
      connectionEpoch: epoch,
      audioTurnId: this.audioTurnId,
      sequence: ++this.audioChunkSequence,
      timestamp: monotonicTimestamp(),
      bytes
    };
    this.trace('pcm.generated', { bytes: bytes.byteLength, sequence: record.sequence });
    this.onInputAudioChunk?.(new Uint8Array(bytes), {
      connectionEpoch: epoch,
      audioTurnId: this.audioTurnId,
      sequence: record.sequence,
      timestamp: record.timestamp
    });
    if (!this.providerReady || !this.session || this.preRollDraining || !this.inputSendingEnabled) {
      this.queuePendingInputAudioRecord(record);
      return;
    }
    this.sendPcmRecord(record);
  }

  queuePendingInputAudioRecord(record) {
    const bytes = record.bytes;
    while (
      this.pendingInputAudioChunks.length >= MAX_PENDING_INPUT_AUDIO_CHUNKS
      || this.pendingInputAudioBytes + bytes.byteLength > MAX_PRE_ROLL_BYTES
    ) {
      const dropped = this.pendingInputAudioChunks.shift();
      if (!dropped) break;
      this.pendingInputAudioBytes -= dropped.bytes.byteLength;
      this.trace('pre_roll_overflow', {
        droppedSequence: dropped.sequence,
        droppedBytes: dropped.bytes.byteLength,
        bufferedBytes: this.pendingInputAudioBytes
      });
    }
    this.pendingInputAudioChunks.push(record);
    this.pendingInputAudioBytes += bytes.byteLength;
    this.trace('pre_roll_enqueued', {
      sequence: record.sequence,
      bytes: bytes.byteLength,
      bufferedBytes: this.pendingInputAudioBytes
    });
  }

  sendPcmRecord(record) {
    if (record.connectionEpoch !== this.connectionEpoch || this.closed || !this.session) return false;
    const bytes = record.bytes;
    if (this.inputTurnMode === 'manual' && this.pcmSendAttemptCount === 0) {
      this.sendProviderInput({ activityStart: {} }, 'activityStart');
    }
    this.sendProviderInput({
      audio: {
        data: bytesToBase64(bytes),
        mimeType: 'audio/pcm;rate=16000'
      }
    }, 'pcm');
    if (!this.firstPcmChunkSent) {
      this.firstPcmChunkSent = true;
      this.logLiveEvent('audio.firstPcmChunkSent', { connectionEpoch: this.connectionEpoch, sessionId: this.liveSessionId });
      this.trace('first_pcm_sent', { sequence: record.sequence });
    }
    return true;
  }

  drainPreRoll(epoch = this.connectionEpoch) {
    if (epoch !== this.connectionEpoch || this.closed || !this.providerReady || !this.session) return false;
    while (this.pendingInputAudioChunks.length > 0) {
      if (epoch !== this.connectionEpoch || this.closed || !this.session) return false;
      const record = this.pendingInputAudioChunks.shift();
      this.pendingInputAudioBytes -= record.bytes.byteLength;
      if (record.connectionEpoch !== epoch) continue;
      this.sendPcmRecord(record);
    }
    return true;
  }

  isCurrentCaptureEpoch(epoch, processor = null) {
    return !this.closed
      && this.captureEnabled
      && epoch === this.connectionEpoch
      && (this.audioGraphEpoch === null || this.audioGraphEpoch === epoch)
      && (!processor || this.processor === processor);
  }

  isCurrentInputEpoch(epoch, processor = null) {
    return this.isCurrentCaptureEpoch(epoch, processor) && this.providerReady && this.inputSendingEnabled;
  }

  isCurrentProviderInputEpoch(epoch) {
    return !this.closed
      && epoch === this.connectionEpoch
      && this.providerReady
      && this.inputSendingEnabled
      && Boolean(this.session);
  }

  async openInputStream() {
    try {
      return await requestAudioInputStream(this.inputDeviceId, {
        timeoutMs: this.microphonePermissionTimeoutMs
      });
    } catch (error) {
      if (!this.inputDeviceId || !isMissingSelectedInputError(error)) {
        throw error;
      }

      this.inputDeviceId = '';
      this.onInputDeviceFallback?.();
      return requestAudioInputStream('', { timeoutMs: this.microphonePermissionTimeoutMs });
    }
  }

  attachMicrophoneTrackListeners() {
    for (const track of this.mediaStream?.getAudioTracks?.() || this.mediaStream?.getTracks?.() || []) {
      if (typeof track?.addEventListener !== 'function') continue;
      const onEnded = () => {
        void this.handleMicrophoneDisconnected();
      };
      track.addEventListener('ended', onEnded);
      this.microphoneTrackListeners.push({ track, onEnded });
    }
  }

  async handleMicrophoneDisconnected() {
    if (this.closeExpected || this.closed || this.microphoneFailureSignaled) return;
    this.microphoneFailureSignaled = true;
    const reasonHint = this.inputDeviceId ? 'selected_device_missing' : 'microphone_disconnected';
    const diagnostic = this.recordFailureDiagnostic({
      source: 'microphone_disconnected',
      reasonHint,
      rawError: new Error('Microphone track ended.')
    });
    this.finalizeInputTurn();
    this.flushPendingTranscripts();
    await this.cleanup({ closeSession: true });
    this.onConnectionFailure?.({
      source: 'microphone_disconnected',
      rawError: new Error('Microphone track ended.'),
      reasonHint,
      diagnostic,
      afterCleanup: true
    });
    this.onError?.(new Error('Microphone track ended.'));
  }

  async handleNetworkOffline() {
    if (this.closeExpected || this.closed) return;
    this.finalizeInputTurn();
    this.flushPendingTranscripts();
    const diagnostic = this.recordFailureDiagnostic({
      source: 'network_offline',
      reasonHint: 'network_offline',
      rawError: new Error('Browser went offline.')
    });
    await this.cleanup({ closeSession: true });
    this.onConnectionFailure?.({
      source: 'network_offline',
      rawError: new Error('Browser went offline.'),
      reasonHint: 'network_offline',
      diagnostic,
      afterCleanup: true
    });
    this.onError?.(new Error('Browser went offline.'));
  }

  retranslateSourceText(sourceText, cueId = '') {
    if (this.mode !== 'translation') return false;
    const text = String(sourceText || '').trim();
    const key = String(cueId || text);
    if (!text || this.closed || !this.session || this.retranslationCueIds.has(key)) return false;

    this.retranslationCueIds.add(key);
    this.activeRetranslationCueId = key;
    try {
      this.session.sendClientContent({
        turns: [{
          role: 'user',
          parts: [{
            text: `Translate the following source text into ${this.targetLanguageCode}. Preserve every digit exactly and return only the translation, without explanation:\n${text}`
          }]
        }],
        turnComplete: true
      });
      return true;
    } catch (error) {
      this.retranslationCueIds.delete(key);
      this.activeRetranslationCueId = null;
      this.logLiveEvent('retranslation.failed', { message: error?.message || 'sendClientContent failed' });
      return false;
    }
  }

  handleMessage(message, epoch = this.connectionEpoch) {
    if (epoch !== this.providerEpoch || this.closed) {
      this.logLiveEvent('stale.callback.ignored', { kind: 'message', connectionEpoch: epoch, activeConnectionEpoch: this.connectionEpoch, sessionId: this.liveSessionId });
      return;
    }
    if (message?.sessionResumptionUpdate?.newHandle) {
      this.resumptionHandle = message.sessionResumptionUpdate.newHandle;
      this.trace('session.resumption.updated');
    }
    if (message?.goAway) {
      this.scheduleProviderReconnect(message.goAway.timeLeft, { forceRefresh: true });
      return;
    }
    const content = message.serverContent;
    if (!this.providerFirstServerEventSeen) {
      this.providerFirstServerEventSeen = true;
      this.trace('provider.firstServerEvent', { kind: 'message' });
    }
    const isFinal = Boolean(content?.turnComplete || content?.generationComplete);
    const retranslationCueId = this.activeRetranslationCueId;
    const isRetranslationResponse = Boolean(retranslationCueId && (
      content?.outputTranscription?.text
      || content?.modelTurn?.parts?.some((part) => part.inlineData?.data)
    ));
    const inputTranscriptArrivedAfterBoundary = this.awaitingInputTranscriptAfterTurnComplete;
    const outputTranscriptArrivedAfterBoundary = this.awaitingOutputTranscriptAfterTurnComplete;
    const inputTranscriptIsFinal = isFinal || this.awaitingInputTranscriptAfterTurnComplete;
    const outputTranscriptIsFinal = isFinal || this.awaitingOutputTranscriptAfterTurnComplete;
    this.eventSequence += 1;
    const transcriptEventId = message?.eventId || message?.event_id || message?.id
      || `${this.liveSessionId || this.sessionId || 'live'}:message:${this.eventSequence}`;
    const normalizedEvents = this.mode === 'transcription'
      ? normalizeTranscriptionCueEvents(message, {
        liveSessionId: this.liveSessionId,
        sessionId: this.sessionId,
        segmentId: this.segmentId,
        sourceLanguageCode: this.sourceLanguageCode,
        connectionEpoch: this.connectionEpoch,
        eventSequence: this.eventSequence,
        sessionClock: this.sessionClock,
        inputTranscriptIsFinal,
        inputTranscriptArrivedAfterBoundary
      })
      : normalizeGeminiLiveCueEvents(message, {
      liveSessionId: this.liveSessionId,
      sessionId: this.sessionId,
      segmentId: this.segmentId,
      sourceLanguageCode: this.sourceLanguageCode,
      targetLanguageCode: this.targetLanguageCode,
      connectionEpoch: this.connectionEpoch,
      eventSequence: this.eventSequence,
      sessionClock: this.sessionClock,
      inputTranscriptIsFinal,
      outputTranscriptIsFinal,
      inputTranscriptArrivedAfterBoundary,
      outputTranscriptArrivedAfterBoundary,
      retranslationCueId: isRetranslationResponse ? retranslationCueId : null
    });
    for (const event of normalizedEvents) {
      if (!(isRetranslationResponse && event.stream === 'source')) {
        this.onCueEvent?.(event);
      }
    }
    this.logLiveEvent('message.received', {
      event: summarizeLiveEvent(message),
      connectionEpoch: epoch,
      sessionId: this.liveSessionId,
      stateBefore: this.transcriptBoundaryState()
    });
    if (isFinal) {
      this.logLiveEvent('turnComplete.received', { connectionEpoch: epoch, sessionId: this.liveSessionId });
      if (content?.generationComplete) this.trace('generationComplete.received');
    }

    if (content?.inputTranscription?.text && !isRetranslationResponse) {
      const transcript = withTranscriptEventId({
        text: content.inputTranscription.text,
        isFinal: isFinal || this.awaitingInputTranscriptAfterTurnComplete,
        connectionEpoch: this.connectionEpoch,
        ...(inputTranscriptArrivedAfterBoundary ? { isLateTranscript: true } : {}),
        ...(content.inputTranscription.sourceLanguageDetection === undefined
          ? {}
          : { sourceLanguageDetection: content.inputTranscription.sourceLanguageDetection })
      }, transcriptEventId);
      this.logLiveEvent('inputTranscription.callback', { transcript });
      this.trace(transcript.isFinal ? 'input.final.received' : 'input.partial.received', { text: transcript.text });
      this.onInputTranscript?.(transcript);
      this.pendingInputTranscript = transcript.isFinal ? null : transcript;
      this.pendingInputTranscriptFinalizableOnTurnComplete = !transcript.isFinal;
      this.awaitingInputTranscriptAfterTurnComplete = false;
    } else if (content?.interimInputTranscription?.text) {
      const transcript = withTranscriptEventId({
        text: content.interimInputTranscription.text,
        isFinal: false,
        connectionEpoch: this.connectionEpoch,
        ...(content.interimInputTranscription.sourceLanguageDetection === undefined
          ? {}
          : { sourceLanguageDetection: content.interimInputTranscription.sourceLanguageDetection })
      }, transcriptEventId);
      this.logLiveEvent('interimInputTranscription.callback', { transcript });
      this.trace('input.partial.received', { text: transcript.text });
      this.onInputTranscript?.(transcript);
      this.pendingInputTranscript = transcript;
      this.pendingInputTranscriptFinalizableOnTurnComplete = false;
    } else if (isFinal && this.pendingInputTranscript && this.pendingInputTranscriptFinalizableOnTurnComplete) {
      const transcript = withTranscriptEventId({ ...this.pendingInputTranscript, isFinal: true }, this.pendingInputTranscript.eventId);
      this.logLiveEvent('inputTranscription.flushOnTurnComplete', { transcript });
      this.onInputTranscript?.(transcript);
      this.pendingInputTranscript = null;
      this.pendingInputTranscriptFinalizableOnTurnComplete = false;
      this.awaitingInputTranscriptAfterTurnComplete = true;
    } else if (isFinal) {
      this.logLiveEvent('inputTranscription.awaitingLateText');
      this.awaitingInputTranscriptAfterTurnComplete = true;
    }

    if (this.mode !== 'transcription' && content?.outputTranscription?.text) {
      const transcript = withTranscriptEventId({
        text: applyGlossaryReplacements(content.outputTranscription.text, this.liveGlossaryEntries),
        isFinal: isFinal || this.awaitingOutputTranscriptAfterTurnComplete,
        connectionEpoch: this.connectionEpoch,
        ...(outputTranscriptArrivedAfterBoundary ? { isLateTranscript: true } : {}),
        ...(isRetranslationResponse ? { retranslationCueId } : {})
      }, transcriptEventId);
      this.logLiveEvent('outputTranscription.callback', { transcript });
      this.onOutputTranscript?.(transcript);
      this.pendingOutputTranscript = transcript.isFinal ? null : transcript;
      this.awaitingOutputTranscriptAfterTurnComplete = false;
    } else if (this.mode !== 'transcription' && isFinal && this.pendingOutputTranscript) {
      const transcript = withTranscriptEventId({ ...this.pendingOutputTranscript, isFinal: true }, this.pendingOutputTranscript.eventId);
      this.logLiveEvent('outputTranscription.flushOnTurnComplete', { transcript });
      this.onOutputTranscript?.(transcript);
      this.pendingOutputTranscript = null;
      this.awaitingOutputTranscriptAfterTurnComplete = true;
    } else if (this.mode !== 'transcription' && isFinal) {
      this.logLiveEvent('outputTranscription.awaitingLateText');
      this.awaitingOutputTranscriptAfterTurnComplete = true;
    }

    if (content?.interrupted) {
      this.clearPlaybackQueue();
    }

    if (this.mode !== 'transcription') {
      const parts = content?.modelTurn?.parts || [];
      for (const part of parts) {
        if (part.inlineData?.data) {
          this.playPcmAudio(part.inlineData.data, { suppressOutput: isRetranslationResponse });
        }
      }
    }

    if (isFinal && isRetranslationResponse && retranslationCueId === this.activeRetranslationCueId) {
      this.activeRetranslationCueId = null;
    }

    this.logLiveEvent('message.processed', {
      stateAfter: this.transcriptBoundaryState()
    });
  }

  playPcmAudio(base64Audio, { suppressOutput = false } = {}) {
    if (!this.audioContext) {
      return;
    }

    const bytes = base64ToBytes(base64Audio);
    if (suppressOutput) return;
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
    this.clearSilenceFinalizeTimer();
    this.finalizeInputTurn();
    this.flushPendingTranscripts();
    await this.cleanup({ closeSession: true });
    this.onClose?.({ reason: 'user-stopped' });
  }

  async handleSessionError(event, epoch = this.connectionEpoch) {
    if (epoch !== this.providerEpoch || this.closed) {
      this.logLiveEvent('stale.callback.ignored', { kind: 'error', connectionEpoch: epoch, activeConnectionEpoch: this.connectionEpoch, sessionId: this.liveSessionId });
      return;
    }
    const message = event?.message || event?.error?.message || 'Live API error';
    const error = event instanceof Error ? event : new Error(message);
    if (!this.providerReconnectInProgress && this.providerReconnectAttempts < 3) {
      try {
        const resumed = await this.reconnectProvider({ forceRefresh: true });
        if (resumed) return;
      } catch {
        // Fall through to the existing recovery callback after bounded resume.
      }
    }
    const diagnostic = this.recordFailureDiagnostic({
      source: 'live_error',
      reasonHint: 'provider_error',
      rawError: error,
      rawEvent: event
    });
    this.finalizeInputTurn();
    this.flushPendingTranscripts();
    await this.cleanup({ closeSession: true });
    this.onConnectionFailure?.({
      source: 'live_error',
      rawError: error,
      rawEvent: event,
      reasonHint: 'provider_error',
      diagnostic,
      afterCleanup: true
    });
    this.onError?.(error);
  }

  async handleSessionClose(event, epoch = this.connectionEpoch) {
    if (epoch !== this.providerEpoch || this.closeExpected || this.closed) {
      if (epoch !== this.connectionEpoch) this.logLiveEvent('stale.callback.ignored', { kind: 'close', connectionEpoch: epoch, activeConnectionEpoch: this.connectionEpoch, sessionId: this.liveSessionId });
      return;
    }

    if (!this.providerReconnectInProgress && this.providerReconnectAttempts < 3) {
      try {
        const resumed = await this.reconnectProvider({
          forceRefresh: true
        });
        if (resumed) return;
      } catch {
        // Fall through to the existing recovery callback after bounded resume.
      }
    }

    const reason = event?.reason ? `: ${event.reason}` : '';
    const code = event?.code ? ` (code ${event.code})` : '';
    const error = new Error(`Live API session closed unexpectedly${reason}${code}`);
    const diagnostic = this.recordFailureDiagnostic({
      source: 'unexpected_close',
      reasonHint: 'unexpected_close',
      rawError: error,
      rawEvent: event
    });
    this.finalizeInputTurn();
    this.flushPendingTranscripts();
    await this.cleanup({ closeSession: false });
    this.onConnectionFailure?.({
      source: 'unexpected_close',
      rawError: error,
      rawEvent: event,
      reasonHint: 'unexpected_close',
      diagnostic,
      afterCleanup: true
    });
    this.onError?.(error);
  }

  tokenExpiresSoon() {
    return !this.tokenState?.expiresAt || Date.parse(this.tokenState.expiresAt) - Date.now() <= TOKEN_REFRESH_SAFETY_MS;
  }

  scheduleProviderReconnect(timeLeft, { forceRefresh = false } = {}) {
    if (this.closed || this.closeExpected || this.providerReconnectTimer) return;
    const match = String(timeLeft || '').match(/([\d.]+)\s*(ms|s|m)?/i);
    const value = match ? Number(match[1]) : 0;
    const unit = (match?.[2] || 'ms').toLowerCase();
    const delay = Math.max(0, Math.min(unit === 'm' ? value * 60000 : unit === 's' ? value * 1000 : value, 30000));
    this.providerReconnectTimer = setTimeout(() => {
      this.providerReconnectTimer = null;
      void this.reconnectProvider({ forceRefresh: forceRefresh || this.tokenExpiresSoon() }).catch(() => {});
    }, delay);
    this.providerReconnectTimer?.unref?.();
  }

  flushPendingTranscripts(options = {}) {
    this.flushPendingTranscript('input', options);
    this.flushPendingTranscript('output', options);
  }

  flushInputAudio() {
    if (!this.isCurrentInputEpoch(this.connectionEpoch) || !this.chunker) return;

    for (const chunk of this.chunker.flush()) {
      this.sendInputAudioChunk(chunk, this.connectionEpoch);
    }
  }

  finalizeInputTurn() {
    if (this.closed) return false;
    if (this.processor) this.processor.onaudioprocess = null;
    this.captureEnabled = false;
    this.logLiveEvent('input.flush.requested', { connectionEpoch: this.connectionEpoch, sessionId: this.liveSessionId });
    if (typeof this.chunker?.flush === 'function') {
      for (const chunk of this.chunker.flush()) {
        this.sendInputAudioChunk(chunk, this.connectionEpoch, { force: true });
      }
    }
    this.inputSendingEnabled = false;
    if (!this.session || !this.providerReady) return false;
    this.preRollDraining = true;
    if (!this.drainPreRoll(this.connectionEpoch)) return false;
    this.preRollDraining = false;
    const payload = this.inputTurnMode === 'manual' ? { activityEnd: {} } : { audioStreamEnd: true };
    const method = this.inputTurnMode === 'manual' ? 'activityEnd' : 'audioStreamEnd';
    this.lastAudioStreamEnd = { payload, method, at: nowIso() };
    this.sendProviderInput(payload, method, { inputEnd: true });
    return true;
  }

  sendProviderInput(payload, method, { inputEnd = false } = {}) {
    if (!this.session?.sendRealtimeInput) {
      const outcome = { method, payload, result: 'unsupported', at: nowIso() };
      if (inputEnd) {
        this.lastInputEnd = outcome;
        this.lastAudioStreamEnd = outcome;
        this.trace('input.end.returned', outcome);
      }
      return { result: 'unsupported' };
    }
    if (inputEnd) this.trace('input.end.invoked', { method, payload });
    else if (method === 'pcm') this.trace('provider.send.invoked', { bytes: payload.audio?.data ? atob(payload.audio.data).length : 0 });
    if (method === 'pcm') {
      this.pcmSendAttemptCount += 1;
      this.firstPcmSendAttemptAt ||= nowIso();
    }
    try {
      const result = this.session.sendRealtimeInput(payload);
      if (inputEnd) {
        this.lastInputEnd = { method, payload, result: result === undefined ? 'sdk-returned-void' : 'returned', at: nowIso() };
        this.lastAudioStreamEnd = this.lastInputEnd;
        this.trace('input.end.returned', { method, result: result === undefined ? 'sdk-returned-void' : 'returned' });
      } else if (method === 'pcm') {
        if (!result || typeof result.then !== 'function') this.pcmSendAcceptedCount += 1;
        this.lastPcmSendAt = nowIso();
        this.trace('provider.send.returned', { result: result === undefined ? 'sdk-returned-void' : 'returned' });
      }
      if (result && typeof result.then === 'function') {
        void result.then(() => {
          if (method === 'pcm') this.pcmSendAcceptedCount += 1;
          this.trace(inputEnd ? 'input.end.returned' : 'provider.send.returned', { result: 'async-resolved' });
        })
          .catch((error) => {
            if (inputEnd) {
              this.lastInputEnd = { method, payload, result: 'async-reject', error: error?.message || String(error), at: nowIso() };
              this.lastAudioStreamEnd = this.lastInputEnd;
            }
            else {
              this.pcmSendAsyncRejectCount += 1;
              void this.handleAudioCaptureFailure('pcm_send_failed', error?.message || 'PCM 音訊未送達 Gemini。');
            }
            this.trace(inputEnd ? 'input.end.asyncReject' : 'provider.send.asyncReject', { method, message: error?.message || String(error) });
          });
      }
      return { result: result === undefined ? 'sdk-returned-void' : 'returned' };
    } catch (error) {
      if (inputEnd) {
        this.lastInputEnd = { method, payload, result: 'sync-throw', error: error?.message || String(error), at: nowIso() };
        this.lastAudioStreamEnd = this.lastInputEnd;
      }
      else if (method === 'pcm') {
        this.pcmSendSyncThrowCount += 1;
        void this.handleAudioCaptureFailure('pcm_send_failed', error?.message || 'PCM 音訊未送達 Gemini。');
      }
      this.trace(inputEnd ? 'input.end.syncThrow' : 'provider.send.syncThrow', { method, message: error?.message || String(error) });
      return { result: 'sync-throw', error: error?.message || String(error) };
    }
  }

  async handleAudioCaptureFailure(reasonHint, message) {
    if (this.closeExpected || this.closed || this.inputTransportFailureSignaled) return;
    this.inputTransportFailureSignaled = true;
    const diagnostic = this.recordFailureDiagnostic({
      source: reasonHint === 'pcm_send_failed' ? 'pcm_send_failed' : 'audio_capture_failed',
      reasonHint,
      rawError: new Error(message)
    });
    await this.cleanup({ closeSession: true });
    const error = new Error(message);
    this.onConnectionFailure?.({
      source: reasonHint === 'pcm_send_failed' ? 'pcm_send_failed' : 'audio_capture_failed',
      rawError: error,
      reasonHint,
      diagnostic,
      afterCleanup: true
    });
    this.onError?.(error);
  }

  flushPendingTranscript(kind, { localFinalize = false } = {}) {
    const isInput = kind === 'input';
    // Emit one local-final marker for the paired Cue. The translation event
    // is flushed second, so marking only that event prevents the source event
    // from finalizing an intermediate Cue and the translation event from
    // creating a duplicate translation-only Cue afterward.
    const emitLocalFinalize = localFinalize && !isInput;
    const pendingKey = isInput ? 'pendingInputTranscript' : 'pendingOutputTranscript';
    const awaitingKey = isInput
      ? 'awaitingInputTranscriptAfterTurnComplete'
      : 'awaitingOutputTranscriptAfterTurnComplete';
    const callback = isInput ? this.onInputTranscript : this.onOutputTranscript;
    const pending = this[pendingKey];

    if (pending) {
      const transcript = withTranscriptEventId({
        ...pending,
        isFinal: true,
        terminalStatus: localFinalize ? 'local-final' : 'saved-pending',
        terminalReason: localFinalize ? 'local-silence' : 'provider-final-unconfirmed',
        providerEndMethod: this.lastInputEnd?.method || null,
        providerEndResult: this.lastInputEnd?.result || null,
        audioTurnId: this.audioTurnId,
        liveSessionId: this.liveSessionId,
        sessionId: this.sessionId,
        segmentId: this.segmentId
      }, pending.eventId);
      this.trace('stopped_pending', { stream: kind, text: transcript.text });
      this.logLiveEvent(`${kind}Transcription.flushPending`, { transcript });
      callback?.(transcript);
      this.onCueEvent?.({
        ...transcript,
        eventId: `${transcript.eventId || `${this.liveSessionId || this.sessionId || 'live'}:pending`}:terminal-final`,
        stream: isInput ? 'source' : 'translation',
        eventType: isInput ? 'input' : 'output',
        localFinalize: emitLocalFinalize,
        finalizedReason: emitLocalFinalize ? 'localSilence' : undefined,
        turnComplete: false,
        generationComplete: false,
        liveSessionId: this.liveSessionId,
        sessionId: this.sessionId,
        segmentId: this.segmentId,
        sourceLanguageCode: this.sourceLanguageCode,
        targetLanguageCode: this.targetLanguageCode,
        connectionEpoch: this.connectionEpoch,
        sessionTimeMs: this.sessionClock()
      });
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

    const eventSequence = details.eventSequence || ++this.traceSequence;
    console.debug('[Gemini Live event]', { stage, ...this.traceContext(), eventSequence, ...details });
  }

  trace(stage, details = {}) {
    this.logLiveEvent(stage, details);
  }

  traceContext() {
    return {
      connectionEpoch: this.connectionEpoch,
      liveSessionId: this.liveSessionId,
      sessionId: this.sessionId,
      audioTurnId: this.audioTurnId,
      timestamp: nowIso()
    };
  }

  getDebugSnapshot() {
    return {
      activeConnectionEpoch: this.closed ? null : this.connectionEpoch,
      activeSessionId: this.closed ? null : this.sessionId,
      activeLiveSessionId: this.closed ? null : this.liveSessionId,
      activeAudioTurnId: this.closed ? null : this.audioTurnId,
      providerReady: this.providerReady,
      captureStarted: this.audioGraphEpoch !== null,
      captureEnabled: this.captureEnabled,
      preRollBufferedChunkCount: this.pendingInputAudioChunks.length,
      preRollBufferedBytes: this.pendingInputAudioBytes,
      inputSendingEnabled: this.inputSendingEnabled,
      audioGraphAttached: Boolean(this.source && this.audioContext),
      processorAttached: Boolean(this.processor),
      audioCallbackCount: this.audioCallbackCount,
      captureRecoveryCount: this.captureRecoveryCount,
      lastAudioCallbackAt: this.lastAudioCallbackAt,
      pcmGeneratedCount: this.pcmGeneratedCount,
      pcmGeneratedBytes: this.pcmGeneratedBytes,
      pcmSendAttemptCount: this.pcmSendAttemptCount,
      pcmSendAcceptedCount: this.pcmSendAcceptedCount,
      pcmSendSyncThrowCount: this.pcmSendSyncThrowCount,
      pcmSendAsyncRejectCount: this.pcmSendAsyncRejectCount,
      firstPcmGeneratedAt: this.firstPcmGeneratedAt,
      firstPcmSendAttemptAt: this.firstPcmSendAttemptAt,
      lastPcmGeneratedAt: this.lastPcmGeneratedAt,
      lastPcmSendAt: this.lastPcmSendAt,
      failureDiagnostics: this.failureDiagnostics.map((failure) => ({ ...failure })),
      lastAudioStreamEnd: this.lastAudioStreamEnd,
      pendingInputTranscript: this.pendingInputTranscript?.text || '',
      pendingOutputTranscript: this.pendingOutputTranscript?.text || '',
      cueStateOwner: this.cueStateOwner,
      lastCueTransitionReason: this.lastCueTransitionReason
    };
  }

  recordFailureDiagnostic(failure = {}) {
    const diagnostic = safeFailureDiagnostic(failure, this);
    this.failureDiagnostics = [...this.failureDiagnostics, diagnostic].slice(-10);
    this.trace('failure.diagnostic', diagnostic);
    return diagnostic;
  }

  async cleanup({ closeSession = true, signalAudioEnd = false } = {}) {
    if (this.cleaningUp) {
      return;
    }

    if (signalAudioEnd) {
      this.finalizeInputTurn();
    }
    this.cleaningUp = true;
    try {
      this.clearSilenceFinalizeTimer();
      if (this.providerReconnectTimer) clearTimeout(this.providerReconnectTimer);
      this.providerReconnectTimer = null;
      this.closed = true;
      this.captureEnabled = false;
      this.inputSendingEnabled = false;
      this.providerReady = false;
      this.connectionEpoch += 1;
      this.audioContext?.removeEventListener?.('statechange', this.audioContextStateHandler);
      this.audioContextStateHandler = null;
      if (this.captureHealthTimer) clearInterval(this.captureHealthTimer);
      this.captureHealthTimer = null;
      for (const { track, onEnded } of this.microphoneTrackListeners) {
        track.removeEventListener?.('ended', onEnded);
      }
      this.microphoneTrackListeners = [];
      this.chunker?.reset();

      this.mediaStream?.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {
          // Media tracks may already be stopped by the browser.
        }
      });

      this.disconnectAudioGraph();

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

      this.clearPlaybackQueue();

      this.processor = null;
      this.source = null;
      this.mediaStream = null;
      this.session = null;
      this.audioContext = null;
      this.chunker = null;
      this.audioGraphEpoch = null;
      this.pendingInputAudioChunks = [];
      this.pendingInputAudioBytes = 0;
      this.localTurnFinalizeTriggered = false;
      this.pendingInputTranscript = null;
      this.pendingInputTranscriptFinalizableOnTurnComplete = false;
      this.pendingOutputTranscript = null;
      this.awaitingInputTranscriptAfterTurnComplete = false;
      this.awaitingOutputTranscriptAfterTurnComplete = false;
      this.nextPlaybackTime = 0;
      if (activeDebugSession === this) activeDebugSession = this;
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

export function createAudioContext() {
  const AudioContextImpl = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (typeof AudioContextImpl !== 'function') {
    throw new DOMException('AudioContext is unavailable.', 'NotSupportedError');
  }
  return new AudioContextImpl();
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await authenticatedFetch(fetch)(url, { ...options, signal: controller.signal });
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

function withTranscriptEventId(transcript, eventId) {
  if (!eventId) return transcript;
  Object.defineProperty(transcript, 'eventId', {
    value: eventId,
    enumerable: false,
    configurable: true
  });
  if (transcript.connectionEpoch !== undefined) {
    Object.defineProperty(transcript, 'connectionEpoch', {
      value: transcript.connectionEpoch,
      enumerable: false,
      configurable: true
    });
  }
  return transcript;
}

function normalizeTranscriptionCueEvents(message, context = {}) {
  const content = message?.serverContent || {};
  const events = [];
  const providerEventId = message?.eventId || message?.event_id || message?.id || content.eventId || content.event_id;
  const eventSequence = context.eventSequence ?? null;
  const sessionTimeMs = typeof context.sessionClock === 'function' ? context.sessionClock() : null;
  const input = content.inputTranscription || content.interimInputTranscription;
  if (input?.text) {
    const eventType = content.inputTranscription?.text ? 'input' : 'input-interim';
    const isFinal = Boolean(content.inputTranscription?.text && (content.turnComplete || content.generationComplete || context.inputTranscriptIsFinal));
    events.push({
      eventId: `${providerEventId || context.liveSessionId || context.sessionId || 'session'}:source:${eventType}:${String(input.text).trim()}`,
      liveSessionId: context.liveSessionId || null,
      sessionId: context.sessionId || null,
      segmentId: context.segmentId || null,
      connectionEpoch: context.connectionEpoch ?? null,
      stream: 'source',
      eventType,
      text: String(input.text).replace(/\s+/gu, ' ').trim(),
      isFinal,
      turnComplete: Boolean(content.turnComplete),
      generationComplete: Boolean(content.generationComplete),
      sourceLanguageCode: input.sourceLanguageCode || context.sourceLanguageCode || null,
      targetLanguageCode: null,
      eventSequence,
      sessionTimeMs,
      ...(context.inputTranscriptArrivedAfterBoundary ? { isLateTranscript: true } : {})
    });
  }
  if (content.turnComplete || content.generationComplete) {
    events.push({
      eventId: `${providerEventId || context.liveSessionId || context.sessionId || 'session'}:control:boundary:${eventSequence || ''}`,
      liveSessionId: context.liveSessionId || null,
      sessionId: context.sessionId || null,
      segmentId: context.segmentId || null,
      connectionEpoch: context.connectionEpoch ?? null,
      stream: null,
      eventType: 'boundary',
      text: '',
      isFinal: false,
      turnComplete: Boolean(content.turnComplete),
      generationComplete: Boolean(content.generationComplete),
      sourceLanguageCode: context.sourceLanguageCode || null,
      targetLanguageCode: null,
      eventSequence,
      sessionTimeMs
    });
  }
  return events.filter((event) => event.stream === null || event.text);
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

function nowIso() {
  return new Date().toISOString();
}

function monotonicTimestamp() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function safeFailureDiagnostic(failure, session) {
  const rawEvent = failure.rawEvent || {};
  const rawError = failure.rawError || {};
  return {
    at: nowIso(),
    source: failure.source || 'unknown',
    reasonHint: failure.reasonHint || 'unknown_error',
    code: safeDiagnosticValue(rawEvent.code || rawError.code),
    status: safeDiagnosticStatus(rawEvent.status || rawError.status || rawError.response?.status),
    providerReason: safeDiagnosticText(rawEvent.reason || rawError.reason),
    connectionEpoch: session.connectionEpoch,
    liveSessionId: session.liveSessionId,
    segmentId: session.segmentId,
    audioCallbackCount: session.audioCallbackCount,
    pcmSendAttemptCount: session.pcmSendAttemptCount,
    pcmSendSyncThrowCount: session.pcmSendSyncThrowCount,
    pcmSendAsyncRejectCount: session.pcmSendAsyncRejectCount
  };
}

function safeDiagnosticValue(value) {
  if (typeof value === 'string' || typeof value === 'number') return value;
  return null;
}

function safeDiagnosticStatus(value) {
  return Number.isInteger(value) ? value : null;
}

function safeDiagnosticText(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value
    .replace(/(?:token|key|authorization|bearer)[^\s:=]*\s*[:=]?\s*[^\s,;]+/gi, '[redacted]')
    .slice(0, 160);
}

function exposeLiveTranslateDebug() {
  if (typeof window === 'undefined' || !LIVE_EVENT_LOG_ENABLED) return;
  window.__liveTranslateDebug = window.__liveTranslateDebug || {};
  window.__liveTranslateDebug.getSnapshot = () => activeDebugSession?.getDebugSnapshot?.() || {
    activeConnectionEpoch: null,
    activeSessionId: null,
    activeLiveSessionId: null,
    activeAudioTurnId: null,
    providerReady: false,
    captureStarted: false,
    captureEnabled: false,
    preRollBufferedChunkCount: 0,
    preRollBufferedBytes: 0,
    inputSendingEnabled: false,
    audioGraphAttached: false,
    processorAttached: false,
    audioCallbackCount: 0,
    captureRecoveryCount: 0,
    pcmGeneratedCount: 0,
    pcmGeneratedBytes: 0,
    pcmSendAttemptCount: 0,
    pcmSendAcceptedCount: 0,
    pcmSendSyncThrowCount: 0,
    pcmSendAsyncRejectCount: 0,
    firstPcmGeneratedAt: null,
    firstPcmSendAttemptAt: null,
    lastPcmGeneratedAt: null,
    lastPcmSendAt: null,
    lastAudioStreamEnd: null,
    failureDiagnostics: [],
    pendingInputTranscript: '',
    pendingOutputTranscript: '',
    cueStateOwner: null,
    lastCueTransitionReason: null
  };
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
    auth_not_configured: '存取權杖未設定或無效，請聯絡管理員。',
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
