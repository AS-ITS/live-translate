import { GoogleGenAI } from '@google/genai';
import {
  base64ToBytes,
  bytesToBase64,
  createPcmChunker,
  OUTPUT_SAMPLE_RATE,
  pcm16ToFloat
} from './audio.js';
import { applyGlossaryReplacements } from './glossaryReplacement.js';
import { isMissingSelectedInputError, requestAudioInputStream } from './mediaDevices.js';
import { setAudioOutputDevice } from './mediaDevices.js';
import { normalizeGeminiLiveCueEvents } from './geminiLiveCueEvent.js';
import { authenticatedFetch } from './accessToken.js';
import { httpStatusFromError, userMessageForErrorCode, withHttpStatus } from './connectionFailures.js';
import { cumulativeTextRelation, isCumulativeExtension } from './cumulativeTranscript.js';
import { createLatencyHistogram, percentileFromLatencyHistogram, recordLatency } from './latencyHistogram.js';

const TOKEN_TIMEOUT_MS = 10000;
const LIVE_CONNECT_TIMEOUT_MS = 15000;
const LIVE_SETUP_TIMEOUT_MS = 15000;
const AUDIO_WORKLET_FIRST_CALLBACK_TIMEOUT_MS = 3000;
const MAX_PENDING_INPUT_AUDIO_CHUNKS = 64;
const MAX_PRE_ROLL_BYTES = 480000;
const AUDIO_CALLBACK_STALL_MS = 3000;
const AUDIO_CALLBACK_GAP_REPORT_MS = 250;
const LOCAL_SILENCE_FINALIZE_MS = 1800;
const TOKEN_REFRESH_SAFETY_MS = 5 * 60 * 1000;
const SPEECH_ACTIVITY_RMS_THRESHOLD = 0.01;
const LIVE_DIAGNOSTICS_ENABLED = Boolean(import.meta.env?.DEV || (typeof __LIVE_TRANSLATE_DIAGNOSTICS__ !== 'undefined' && __LIVE_TRANSLATE_DIAGNOSTICS__));
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
    outputDeviceId = '',
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
    onPlaybackStateChange,
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
    speechActivityRmsThreshold = SPEECH_ACTIVITY_RMS_THRESHOLD,
    firstPcmTimeoutMs = LIVE_SETUP_TIMEOUT_MS
    , mode = 'translation'
  }) {
    this.mode = mode;
    this.targetLanguageCode = targetLanguageCode;
    this.sourceLanguageCode = sourceLanguageCode;
    this.echoTargetLanguage = echoTargetLanguage;
    this.inputDeviceId = inputDeviceId;
    this.outputDeviceId = outputDeviceId;
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
    this.onPlaybackStateChange = onPlaybackStateChange;
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
    this.previousAudioTurnId = null;
    this.activeTranscriptAudioTurnId = this.audioTurnId;
    this.silenceFinalizeMs = silenceFinalizeMs;
    this.speechActivityRmsThreshold = speechActivityRmsThreshold;
    this.firstPcmTimeoutMs = firstPcmTimeoutMs;
    this.inputSendingEnabled = false;
    this.captureEnabled = false;
    this.preRollDraining = false;
    this.providerReady = false;
    this.audioGraphEpoch = null;
    this.captureGraphGeneration = 0;
    this.activeCaptureGraphGeneration = null;
    this.firstPcmChunkSent = false;
    this.eventSequence = 0;
    this.traceSequence = 0;
    this.providerFirstServerEventSeen = false;
    this.audioCallbackCount = 0;
    this.lastAudioCallbackType = null;
    this.audioCallbackGapCount = 0;
    this.maxAudioCallbackGapMs = 0;
    this.lastAudioCallbackGapMs = null;
    this.audioCallbackGapHistogram = createLatencyHistogram();
    this.lastWorkletProcessCount = null;
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
    this.captureProcessorMode = 'script';
    this.audioCaptureStage = 'not_started';
    this.startupStage = 'idle';
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
    this.lastInputTranscriptText = '';
    this.lastOutputTranscriptText = '';
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
    this.audioWorkletFallbackAttempted = false;
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
    this.startPromise = null;
    this.setupCompletePromise = null;
    this.setupCompleteResolver = null;
    this.firstPcmPromise = null;
    this.firstPcmResolver = null;
    this.firstPcmRejecter = null;
    activeDebugSession = this;
    exposeLiveTranslateDebug();
  }

  async start({ inputStream = null } = {}) {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startLifecycle({ inputStream }).catch(async (error) => {
      this.logLiveEvent('startup:failure', { stage: this.audioCaptureStage, message: error?.message || String(error) });
      await this.cleanup({ closeSession: true, reason: 'startup-failure' });
      throw error;
    });
    return this.startPromise;
  }

  async startLifecycle({ inputStream = null } = {}) {
    this.trace('connect.invoked');
    this.logLiveEvent('getUserMedia:start', { selectedDeviceId: this.inputDeviceId || 'default' });
    try {
      this.mediaStream = inputStream || await this.openInputStream();
    } catch (error) {
      this.startupStage = 'getUserMedia';
      this.logLiveEvent('getUserMedia:failure', { message: error?.message || String(error), name: error?.name || null });
      error.userMessage = error?.name === 'NotAllowedError'
        ? '麥克風權限被拒絕。'
        : '無法取得麥克風 stream。';
      throw error;
    }
    const tracks = this.mediaStream?.getAudioTracks?.() || this.mediaStream?.getTracks?.() || [];
    const track = tracks[0];
    if (!this.mediaStream?.active || !track || track.readyState === 'ended') {
      throw this.startupError('microphone_stream_invalid', '麥克風 track 已失效。');
    }
    this.attachMicrophoneTrackListeners();
    this.logLiveEvent('getUserMedia:success', {
      selectedDeviceId: this.inputDeviceId || 'default',
      streamActive: this.mediaStream.active,
      trackReadyState: track.readyState,
      trackEnabled: track.enabled !== false
    });
    this.onMicrophoneReady?.({ mediaStream: this.mediaStream });
    this.startupStage = 'live_token';
    this.onConnecting?.();
    if (!this.firstPcmChunkSent) {
      this.firstPcmPromise = new Promise((resolve, reject) => {
        this.firstPcmResolver = resolve;
        this.firstPcmRejecter = reject;
      });
    }
    // Start capture before provider setup so speech during the handshake is buffered.
    await this.attachAudioCaptureAfterSetup();
    const connected = await this.connectProvider();
    if (!connected) return false;
    await this.waitForFirstPcm();
    return true;
  }

  async waitForFirstPcm() {
    try {
      await withTimeout(this.firstPcmPromise, this.firstPcmTimeoutMs, '首個音訊資料未成功送出。');
    } catch (error) {
      this.startupStage = 'first_pcm';
      error.reasonHint = 'first_pcm_timeout';
      error.userMessage = '錄音音訊管線未啟動，請重試。';
      this.logLiveEvent('firstPcm:timeout', {
        audioCaptureStage: this.audioCaptureStage,
        captureProcessorMode: this.captureProcessorMode,
        audioCallbackCount: this.audioCallbackCount,
        pcmGeneratedCount: this.pcmGeneratedCount,
        pcmSendAttemptCount: this.pcmSendAttemptCount
      });
      throw error;
    }
  }

  async getTokenResponse({ forceRefresh = false } = {}) {
    const expiresAt = this.tokenState?.expiresAt ? Date.parse(this.tokenState.expiresAt) : 0;
    if (!forceRefresh && this.tokenState && expiresAt - Date.now() > TOKEN_REFRESH_SAFETY_MS) return this.tokenState;
    let tokenResponse;
    try {
      tokenResponse = await fetchWithTimeout('/api/live-token', {
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
    } catch (error) {
      this.startupStage = 'live_token';
      error.userMessage ||= '無法取得即時權杖。';
      this.logLiveEvent('liveToken:failure', { message: error?.message || String(error) });
      throw error;
    }
    if (!tokenResponse.ok) {
      const error = await tokenResponse.json().catch(() => ({ error: { code: 'token_request_failed' } }));
      const errorCode = error.error?.code || 'token_request_failed';
      const startupMessage = userMessageForErrorCode(errorCode) || '無法準備即時翻譯請求。';
      const startupError = new Error(startupMessage);
      startupError.code = errorCode;
      startupError.status = tokenResponse.status;
      startupError.userMessage = withHttpStatus(startupMessage, tokenResponse.status);
      throw startupError;
    }
    const response = await tokenResponse.json();
    this.logLiveEvent('liveToken:success', { expiresAt: response.expiresAt || null });
    this.tokenState = { ...response, fetchedAt: Date.now() };
    this.liveGlossaryEntries = Array.isArray(response.liveGlossaryEntries) ? response.liveGlossaryEntries : [];
    return this.tokenState;
  }

  async connectProvider({ forceRefresh = false } = {}) {
    this.startupStage = 'socket';
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
        onerror: (event) => {
          this.logLiveEvent('socket:error', { connectionEpoch: this.connectionEpoch, message: event?.message || event?.error?.message || 'Live API error' });
          void this.handleSessionError(event, providerEpoch);
        },
        onclose: (event) => { void this.handleSessionClose(event, providerEpoch); }
      }
    }), LIVE_CONNECT_TIMEOUT_MS, '即時翻譯連線逾時。請再試一次。');
    if (this.closed || this.connectionEpoch !== connectionEpoch || this.providerEpoch !== providerEpoch) {
      try { connectedSession?.close?.(); } catch { /* stale provider session */ }
      return false;
    }
    this.session = connectedSession;
    this.logLiveEvent('socket:open', { connectionEpoch: this.connectionEpoch, sessionId: this.liveSessionId });
    this.trace('connect.resolved');
    this.providerReady = true;
    this.preRollDraining = true;
    this.inputSendingEnabled = false;
    await this.waitForSetupComplete(providerEpoch);
    await this.attachAudioCaptureAfterSetup();
    if (!this.drainPreRoll(connectionEpoch)) return false;
    this.preRollDraining = false;
    this.inputSendingEnabled = true;
    this.logLiveEvent('provider:ready', { connectionEpoch: this.connectionEpoch, sessionId: this.liveSessionId });
    this.onProviderReady?.({ connectionEpoch: this.connectionEpoch });
    return true;
  }

  async waitForSetupComplete(providerEpoch) {
    this.setupCompletePromise = new Promise((resolve, reject) => {
      this.setupCompleteResolver = { resolve, reject, providerEpoch };
    });
    try {
      await withTimeout(this.setupCompletePromise, LIVE_SETUP_TIMEOUT_MS, 'Gemini 連線尚未完成。');
    } catch (error) {
      this.startupStage = 'socket';
      error.userMessage ||= 'Gemini 連線尚未完成。';
      this.logLiveEvent('socket:error', { stage: 'setupComplete', message: error?.message || String(error) });
      throw error;
    } finally {
      this.setupCompletePromise = null;
      this.setupCompleteResolver = null;
    }
  }

  async attachAudioCaptureAfterSetup() {
    if (this.audioContext && this.audioGraphEpoch !== null && this.captureEnabled) {
      if (!await this.ensureAudioContextRunning()) throw this.startupError('audio_context_lost', 'AudioContext 無法啟動。');
      return;
    }
    this.audioContext = createAudioContext();
    this.logLiveEvent('audioContext:create', { state: this.audioContext.state || null });
    if (!await this.ensureAudioContextRunning()) throw this.startupError('audio_context_lost', 'AudioContext 無法啟動。');
    await this.prepareAudioCaptureProcessor();
    await this.setOutputDevice(this.outputDeviceId);
    this.chunker = createPcmChunker({ sourceRate: this.audioContext.sampleRate });
    if (!this.setupAudioCapture()) throw this.startupError('audio_graph_attach_failed', '音訊 graph 無法建立。');
    this.onCaptureStateChange?.({ state: 'capturing', connectionEpoch: this.connectionEpoch });
  }

  startupError(reason, message) {
    this.startupStage = reason;
    this.audioCaptureStage = reason;
    const error = new Error(message);
    error.userMessage = message;
    error.startupStage = reason;
    error.reasonHint = reason;
    this.recordFailureDiagnostic({ source: 'startup', reasonHint: reason, rawError: error });
    return error;
  }

  async reconnectProvider({
    segmentId = this.segmentId,
    liveSessionId = this.liveSessionId,
    forceRefresh = false
  } = {}) {
    if (this.closed) return false;
    if (this.providerReconnectInProgress) return this.providerReconnectInProgress;
    this.segmentId = segmentId;
    this.liveSessionId = liveSessionId || this.liveSessionId;
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
    const captureGraphGeneration = ++this.captureGraphGeneration;
    this.source = this.audioContext.createMediaStreamSource(this.mediaStream);
    this.processor = this.createCaptureProcessor();
    const processor = this.processor;
    this.audioCaptureStage = this.captureProcessorMode === 'worklet'
      ? 'audio_worklet_attached'
      : 'script_processor_selected';
    this.audioGraphEpoch = captureEpoch;
    this.activeCaptureGraphGeneration = captureGraphGeneration;
    this.captureEnabled = true;
    this.captureStartedAt = Date.now();
    this.lastAudioCallbackAt = null;
    this.audioCallbackGapCount = 0;
    this.maxAudioCallbackGapMs = 0;
    this.lastAudioCallbackGapMs = null;
    this.audioCallbackGapHistogram = createLatencyHistogram();
    this.lastWorkletProcessCount = null;
    this.trace('capture_started');
    this.logLiveEvent('audio.processor.selected', {
      mode: this.captureProcessorMode,
      connectionEpoch: this.connectionEpoch,
      captureGraphGeneration
    });
    this.logLiveEvent('audio.graph.attached', { connectionEpoch: this.connectionEpoch, sessionId: this.liveSessionId });
    this.logLiveEvent('audioGraph:attached', { connectionEpoch: this.connectionEpoch, sessionId: this.liveSessionId });
    const handleSamples = (input) => {
      if (!this.isCurrentCaptureEpoch(captureEpoch, processor, captureGraphGeneration) || !this.chunker) {
        if (this.closed || captureEpoch !== this.connectionEpoch) this.trace('stale.callback.ignored', { kind: 'audio' });
        return;
      }

      this.audioCallbackCount += 1;
      const callbackAt = Date.now();
      const callbackGapMs = this.lastAudioCallbackAt === null ? 0 : Math.max(0, callbackAt - this.lastAudioCallbackAt);
      this.lastAudioCallbackGapMs = callbackGapMs;
      this.maxAudioCallbackGapMs = Math.max(this.maxAudioCallbackGapMs, callbackGapMs);
      recordLatency(this.audioCallbackGapHistogram, callbackGapMs);
      if (callbackGapMs >= AUDIO_CALLBACK_GAP_REPORT_MS) this.audioCallbackGapCount += 1;
      this.lastAudioCallbackAt = callbackAt;
      this.lastAudioCallbackType = this.captureProcessorMode;
      this.audioCaptureStage = `${this.captureProcessorMode}_callback`;
      if (this.audioCallbackCount === 1) this.trace('audio.callback.first');

      // Count only consecutive stalls. A later healthy callback means the
      // browser capture graph recovered from a transient scheduling pause.
      this.captureRecoveryCount = 0;

      this.trackSpeechActivity(input);
      const chunks = this.chunker.push(input);

      for (const chunk of chunks) {
        this.sendInputAudioChunk(chunk, captureEpoch);
      }
    };

    if (this.captureProcessorMode === 'worklet') {
      this.processor.port.onmessage = (event) => {
        const payload = event.data;
        const samples = payload?.type === 'pcm' ? payload.samples : payload;
        if (!samples) return;
        this.lastWorkletProcessCount = payload?.type === 'pcm' ? payload.processCount || null : null;
        handleSamples(new Float32Array(samples));
      };
    } else {
      this.processor.onaudioprocess = (event) => handleSamples(event.inputBuffer.getChannelData(0));
    }

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

  createCaptureProcessor() {
    if (this.captureProcessorMode === 'worklet') {
      try {
        return new globalThis.AudioWorkletNode(this.audioContext, 'pcm-capture', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1]
        });
      } catch (error) {
        this.captureProcessorMode = 'script';
        this.audioCaptureStage = 'audio_worklet_initialization_failed';
        this.recordFailureDiagnostic({
          source: 'audio_capture',
          reasonHint: 'audio_worklet_unavailable',
          rawError: error
        });
      }
    }

    return this.audioContext.createScriptProcessor(4096, 1, 1);
  }

  async prepareAudioCaptureProcessor() {
    const worklet = this.audioContext?.audioWorklet;
    const AudioWorkletNodeImpl = globalThis.AudioWorkletNode;
    if (!worklet || typeof worklet.addModule !== 'function' || typeof AudioWorkletNodeImpl !== 'function') {
      this.captureProcessorMode = 'script';
      this.audioCaptureStage = 'script_processor_selected';
      return false;
    }

    try {
      await worklet.addModule(new URL('./audioCapture.worklet.js', import.meta.url));
      this.captureProcessorMode = 'worklet';
      this.audioCaptureStage = 'audio_worklet_ready';
      return true;
    } catch (error) {
      this.captureProcessorMode = 'script';
      this.audioCaptureStage = 'audio_worklet_initialization_failed';
      this.recordFailureDiagnostic({ source: 'audio_capture', reasonHint: 'audio_worklet_unavailable', rawError: error });
      return false;
    }
  }

  async setOutputDevice(deviceId = '') {
    this.outputDeviceId = deviceId || '';
    if (!this.audioContext) return false;
    try {
      const supported = await setAudioOutputDevice(this.audioContext, this.outputDeviceId);
      if (supported) this.onPlaybackStateChange?.({ state: 'ready', outputDeviceId: this.outputDeviceId });
      return supported;
    } catch (error) {
      this.onPlaybackStateChange?.({ state: 'error', outputDeviceId: this.outputDeviceId, error });
      return false;
    }
  }

  async replaceInputStream(nextStream) {
    if (this.closed || !nextStream) return false;
    const previousStream = this.mediaStream;
    this.detachMicrophoneTrackListeners();
    this.mediaStream = nextStream;
    this.attachMicrophoneTrackListeners();
    const attached = this.setupAudioCapture();
    if (!attached) {
      this.detachMicrophoneTrackListeners();
      this.mediaStream = previousStream;
      this.attachMicrophoneTrackListeners();
      this.setupAudioCapture();
      return false;
    }
    previousStream?.getTracks?.().forEach((track) => track.stop?.());
    this.onMicrophoneReady?.({ mediaStream: nextStream });
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
    if (this.audioContext.state === 'closed') {
      this.audioCaptureStage = 'audio_context_lost';
      await this.handleAudioCaptureFailure('audio_context_lost', '瀏覽器音訊工作階段已停止。');
      return false;
    }
    if (this.audioContext.state === 'suspended') {
      const resumed = await this.ensureAudioContextRunning();
      if (resumed) return true;
      if (!this.closed) {
        this.audioCaptureStage = 'audio_context_lost';
        await this.handleAudioCaptureFailure('audio_context_lost', '瀏覽器音訊工作階段無法恢復。');
      }
      return false;
    }
    const endedTrack = (this.mediaStream?.getAudioTracks?.() || this.mediaStream?.getTracks?.())
      .find((track) => track?.readyState === 'ended');
    if (endedTrack) {
      await this.handleMicrophoneDisconnected();
      return false;
    }
    // A provider handshake can legitimately outlast the audio callback watchdog.
    // Defer stall recovery until there is a provider session to receive the pre-roll.
    if (!this.session || !this.providerReady) return true;
    const lastCallbackAt = this.lastAudioCallbackAt || this.captureStartedAt;
    if (!lastCallbackAt || now - lastCallbackAt < AUDIO_CALLBACK_STALL_MS) return true;
    if (this.captureProcessorMode === 'worklet') {
      if (this.audioCallbackCount !== 0) return true;
      if (this.audioWorkletFallbackAttempted) return true;
      if (now - this.captureStartedAt < AUDIO_WORKLET_FIRST_CALLBACK_TIMEOUT_MS) return true;

      this.audioWorkletFallbackAttempted = true;
      this.captureRecoveryCount = 0;
      this.audioCaptureStage = 'audio_worklet_callback_stalled';
      this.logLiveEvent('audio.processor.fallback', {
        from: 'worklet',
        to: 'script',
        reason: 'audio_callback_not_received',
        elapsedMs: now - this.captureStartedAt,
        audioCallbackCount: this.audioCallbackCount,
        connectionEpoch: this.connectionEpoch,
        captureGraphGeneration: this.activeCaptureGraphGeneration
      });
      this.recordFailureDiagnostic({
        source: 'audio_capture',
        reasonHint: 'audio_callback_not_received'
      });
      this.captureProcessorMode = 'script';
      return this.recoverAudioCapture({
        expectedEpoch: this.connectionEpoch,
        expectedGraphGeneration: this.activeCaptureGraphGeneration,
        requireProviderSession: true
      });
    }
    if (this.captureRecoveryCount < 1) {
      this.captureRecoveryCount += 1;
      this.audioCaptureStage = 'script_processor_callback_stalled';
      this.recordFailureDiagnostic({
        source: 'audio_capture',
        reasonHint: 'script_processor_callback_stalled'
      });
      this.trace('audio.callback.stalled', { recoveryCount: this.captureRecoveryCount });
      return this.recoverAudioCapture();
    }
    if (!this.firstPcmChunkSent && this.firstPcmRejecter) {
      this.rejectFirstPcm('first_pcm_timeout', '錄音音訊管線未啟動，請重試。');
      return false;
    }
    this.audioCaptureStage = 'script_processor_callback_failed';
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
      if (this.audioContext.state !== 'running') {
        await this.handleAudioCaptureFailure('audio_context_lost', '瀏覽器音訊工作階段無法恢復。');
        return false;
      }
    } else if (this.audioContext.state === 'suspended') {
      await this.handleAudioCaptureFailure('audio_context_lost', '瀏覽器音訊工作階段無法恢復。');
      return false;
    }
    return this.audioContext.state === undefined || this.audioContext.state === 'running';
  }

  disconnectAudioGraph() {
    try { this.processor?.disconnect(); } catch { /* already disconnected */ }
    try { this.source?.disconnect(); } catch { /* already disconnected */ }
    if (this.processor) this.processor.onaudioprocess = null;
    if (this.processor?.port) this.processor.port.onmessage = null;
    this.processor = null;
    this.source = null;
    this.audioGraphEpoch = null;
    this.activeCaptureGraphGeneration = null;
  }

  async recoverAudioCapture({ expectedEpoch = this.connectionEpoch, expectedGraphGeneration = this.activeCaptureGraphGeneration, requireProviderSession = false } = {}) {
    if (this.closed
      || !this.mediaStream
      || !this.audioContext
      || !this.captureEnabled
      || expectedEpoch !== this.connectionEpoch
      || expectedGraphGeneration !== this.activeCaptureGraphGeneration
      || (requireProviderSession && (!this.session || !this.providerReady))) return false;
    if (!await this.ensureAudioContextRunning()) return false;
    // setupAudioCapture starts by disconnecting the previous graph. This is
    // important when a stalled Worklet is replaced so both processors cannot
    // continue consuming the same microphone stream.
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
    const outcome = this.sendProviderInput({
      audio: {
        data: bytesToBase64(bytes),
        mimeType: 'audio/pcm;rate=16000'
      }
    }, 'pcm');
    if (!this.firstPcmChunkSent && outcome.result !== 'sync-throw' && outcome.result !== 'unsupported') {
      this.firstPcmChunkSent = true;
      const elapsedMs = Math.max(0, Date.now() - (this.captureStartedAt || Date.now()));
      this.logLiveEvent('audio.firstPcmChunkSent', { connectionEpoch: this.connectionEpoch, sessionId: this.liveSessionId });
      this.logLiveEvent('firstPcmChunk:sent', {
        connectionEpoch: this.connectionEpoch,
        sessionId: this.liveSessionId,
        elapsedMs,
        captureProcessorMode: this.captureProcessorMode,
        audioCallbackCount: this.audioCallbackCount,
        pcmGeneratedCount: this.pcmGeneratedCount,
        pcmSendAttemptCount: this.pcmSendAttemptCount
      });
      this.trace('first_pcm_sent', { sequence: record.sequence });
      this.firstPcmResolver?.(true);
      this.firstPcmResolver = null;
      this.firstPcmRejecter = null;
    }
    return true;
  }

  rejectFirstPcm(reasonHint, message) {
    if (!this.firstPcmRejecter || this.firstPcmChunkSent) return false;
    const error = new Error(message);
    error.reasonHint = reasonHint;
    error.startupStage = 'first_pcm';
    error.userMessage = message;
    this.firstPcmRejecter(error);
    this.firstPcmRejecter = null;
    this.firstPcmResolver = null;
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

  isCurrentCaptureEpoch(epoch, processor = null, graphGeneration = null) {
    return !this.closed
      && this.captureEnabled
      && epoch === this.connectionEpoch
      && (this.audioGraphEpoch === null || this.audioGraphEpoch === epoch)
      && (graphGeneration === null || this.activeCaptureGraphGeneration === graphGeneration)
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

  detachMicrophoneTrackListeners() {
    for (const { track, onEnded } of this.microphoneTrackListeners) {
      track.removeEventListener?.('ended', onEnded);
    }
    this.microphoneTrackListeners = [];
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
    if (message?.setupComplete) {
      this.logLiveEvent('socket:setupComplete', { connectionEpoch: this.connectionEpoch, sessionId: this.liveSessionId });
      if (this.setupCompleteResolver?.providerEpoch === epoch) this.setupCompleteResolver.resolve(true);
      return;
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
    const cumulativeInputContinuation = isCumulativeExtension(
      this.lastInputTranscriptText,
      content?.inputTranscription?.text || content?.interimInputTranscription?.text
    );
    const cumulativeOutputContinuation = isCumulativeExtension(
      this.lastOutputTranscriptText,
      content?.outputTranscription?.text
    );
    const providerTurnIndex = firstDefined(
      content?.turnIndex,
      content?.turn?.index,
      content?.turn?.turnIndex,
      message?.turnIndex
    );
    const likelyFragmentContinuation = isLikelyTranscriptContinuation(
      this.lastInputTranscriptText,
      content?.inputTranscription?.text || content?.interimInputTranscription?.text,
      { stream: 'source', turnIndex: providerTurnIndex }
    ) || isLikelyTranscriptContinuation(
      this.lastOutputTranscriptText,
      content?.outputTranscription?.text,
      { stream: 'translation', turnIndex: providerTurnIndex }
    );
    const inputTextMergeMode = transcriptMergeMode(this.lastInputTranscriptText, content?.inputTranscription?.text || content?.interimInputTranscription?.text);
    const outputTextMergeMode = transcriptMergeMode(this.lastOutputTranscriptText, content?.outputTranscription?.text);
    const providerTurnId = providerTurnIndex === undefined || providerTurnIndex === null
      ? null
      : `provider-turn-${this.connectionEpoch}-${providerTurnIndex}`;
    const eventAudioTurnId = providerTurnId || ((inputTranscriptArrivedAfterBoundary || outputTranscriptArrivedAfterBoundary
      || cumulativeInputContinuation || cumulativeOutputContinuation || likelyFragmentContinuation)
      ? (this.activeTranscriptAudioTurnId || this.previousAudioTurnId || this.audioTurnId)
      : this.audioTurnId);
    if (content?.inputTranscription?.text || content?.interimInputTranscription?.text || content?.outputTranscription?.text) {
      this.activeTranscriptAudioTurnId = eventAudioTurnId;
    }
    this.logLiveEvent('transcript.normalized', {
      raw: summarizeLiveEvent(message),
      isFinal,
      inputTranscriptIsFinal,
      outputTranscriptIsFinal,
      cumulativeInputContinuation,
      cumulativeOutputContinuation,
      inputTextMergeMode,
      outputTextMergeMode,
      eventAudioTurnId,
      eventSequence: this.eventSequence
    });
    const normalizedEvents = this.mode === 'transcription'
      ? normalizeTranscriptionCueEvents(message, {
        liveSessionId: this.liveSessionId,
        sessionId: this.sessionId,
        segmentId: this.segmentId,
        sourceLanguageCode: this.sourceLanguageCode,
        connectionEpoch: this.connectionEpoch,
        eventSequence: this.eventSequence,
        audioTurnId: eventAudioTurnId,
        turnKey: `local:${eventAudioTurnId}`,
        turnIdentitySource: 'local',
        sessionClock: this.sessionClock,
        inputTranscriptIsFinal,
        inputTranscriptArrivedAfterBoundary,
        inputTextMergeMode
      })
      : normalizeGeminiLiveCueEvents(message, {
      liveSessionId: this.liveSessionId,
      sessionId: this.sessionId,
      segmentId: this.segmentId,
      sourceLanguageCode: this.sourceLanguageCode,
      targetLanguageCode: this.targetLanguageCode,
      connectionEpoch: this.connectionEpoch,
      eventSequence: this.eventSequence,
      audioTurnId: eventAudioTurnId,
      turnKey: `local:${eventAudioTurnId}`,
      turnIdentitySource: 'local',
      sessionClock: this.sessionClock,
      inputTranscriptIsFinal,
      outputTranscriptIsFinal,
      inputTranscriptArrivedAfterBoundary,
      outputTranscriptArrivedAfterBoundary,
      inputTextMergeMode,
      outputTextMergeMode,
      retranslationCueId: isRetranslationResponse ? retranslationCueId : null
    });
    for (const event of normalizedEvents) {
      this.logLiveEvent('cue.normalized', {
        stream: event.stream,
        text: event.text,
        textMergeMode: event.textMergeMode,
        isFinal: event.isFinal,
        turnComplete: event.turnComplete,
        generationComplete: event.generationComplete,
        audioTurnId: event.audioTurnId,
        eventSequence: event.eventSequence,
        connectionEpoch: event.connectionEpoch,
        segmentId: event.segmentId,
        eventId: event.eventId
      });
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
        liveSessionId: this.liveSessionId,
        sessionId: this.sessionId,
        segmentId: this.segmentId,
        sourceLanguageCode: this.sourceLanguageCode,
        connectionEpoch: this.connectionEpoch,
        audioTurnId: eventAudioTurnId,
        ...(inputTranscriptArrivedAfterBoundary ? { isLateTranscript: true } : {}),
        ...(content.inputTranscription.sourceLanguageDetection === undefined
          ? {}
          : { sourceLanguageDetection: content.inputTranscription.sourceLanguageDetection })
      }, transcriptEventId);
      this.logLiveEvent('inputTranscription.callback', { transcript });
      this.trace(transcript.isFinal ? 'input.final.received' : 'input.partial.received', { text: transcript.text });
      this.onInputTranscript?.(transcript);
      this.lastInputTranscriptText = transcript.text;
      this.pendingInputTranscript = transcript.isFinal ? null : transcript;
      this.pendingInputTranscriptFinalizableOnTurnComplete = !transcript.isFinal;
      this.awaitingInputTranscriptAfterTurnComplete = false;
    } else if (content?.interimInputTranscription?.text) {
      const transcript = withTranscriptEventId({
        text: content.interimInputTranscription.text,
        isFinal: false,
        liveSessionId: this.liveSessionId,
        sessionId: this.sessionId,
        segmentId: this.segmentId,
        sourceLanguageCode: this.sourceLanguageCode,
        connectionEpoch: this.connectionEpoch,
        audioTurnId: eventAudioTurnId,
        ...(content.interimInputTranscription.sourceLanguageDetection === undefined
          ? {}
          : { sourceLanguageDetection: content.interimInputTranscription.sourceLanguageDetection })
      }, transcriptEventId);
      this.logLiveEvent('interimInputTranscription.callback', { transcript });
      this.trace('input.partial.received', { text: transcript.text });
      this.onInputTranscript?.(transcript);
      this.lastInputTranscriptText = transcript.text;
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
        liveSessionId: this.liveSessionId,
        sessionId: this.sessionId,
        segmentId: this.segmentId,
        sourceLanguageCode: this.sourceLanguageCode,
        targetLanguageCode: this.targetLanguageCode,
        connectionEpoch: this.connectionEpoch,
        audioTurnId: eventAudioTurnId,
        ...(outputTranscriptArrivedAfterBoundary ? { isLateTranscript: true } : {}),
        ...(isRetranslationResponse ? { retranslationCueId } : {})
      }, transcriptEventId);
      this.logLiveEvent('outputTranscription.callback', { transcript });
      this.onOutputTranscript?.(transcript);
      this.lastOutputTranscriptText = transcript.text;
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

    if (isFinal && !inputTranscriptArrivedAfterBoundary && !outputTranscriptArrivedAfterBoundary) {
      this.previousAudioTurnId = this.audioTurnId;
      this.audioTurnId = `audio-turn-${this.connectionEpoch}-${++nextAudioTurnSequence}`;
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
    let buffer;
    try {
      buffer = this.audioContext.createBuffer(1, samples.length, OUTPUT_SAMPLE_RATE);
    } catch (error) {
      this.onPlaybackStateChange?.({ state: 'error', error });
      return;
    }
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
    try {
      source.start(this.nextPlaybackTime);
    } catch (error) {
      this.playbackSources.delete(source);
      this.onPlaybackStateChange?.({ state: 'error', error });
      return;
    }
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
    const message = event?.message || event?.error?.message || event?.error?.error?.message || 'Live API error';
    const error = event instanceof Error ? event : new Error(message);
    if (event && typeof event === 'object' && error !== event) {
      Object.assign(error, event);
    }
    if (event?.error && error.error !== event.error) {
      error.error = event.error;
    }
    if (error.code == null) {
      error.code = event?.code ?? event?.error?.code ?? event?.error?.error?.code;
    }
    if (error.status == null) {
      const status = httpStatusFromError(event);
      if (status !== null) error.status = status;
    }
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

  getDebugSnapshot({ includeText = LIVE_EVENT_LOG_ENABLED } = {}) {
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
      captureProcessorMode: this.captureProcessorMode,
      captureGraphGeneration: this.captureGraphGeneration,
      activeCaptureGraphGeneration: this.activeCaptureGraphGeneration,
      audioCaptureStage: this.audioCaptureStage,
      startupStage: this.startupStage,
      audioCallbackCount: this.audioCallbackCount,
      audioCallbackGapCount: this.audioCallbackGapCount,
      maxAudioCallbackGapMs: this.maxAudioCallbackGapMs,
      lastAudioCallbackGapMs: this.lastAudioCallbackGapMs,
      audioCallbackGapP95Ms: percentileFromLatencyHistogram(this.audioCallbackGapHistogram),
      lastWorkletProcessCount: this.lastWorkletProcessCount,
      lastAudioCallbackType: this.lastAudioCallbackType,
      audioContextState: this.audioContext?.state || null,
      microphoneTrackState: (this.mediaStream?.getAudioTracks?.() || this.mediaStream?.getTracks?.())?.[0]?.readyState || null,
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
      pendingInputTranscript: includeText ? this.pendingInputTranscript?.text || '' : null,
      pendingOutputTranscript: includeText ? this.pendingOutputTranscript?.text || '' : null,
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

  async cleanup({ closeSession = true, signalAudioEnd = false, reason = 'cleanup' } = {}) {
    if (this.cleaningUp) {
      return;
    }

    if (signalAudioEnd) {
      this.finalizeInputTurn();
    }
    this.cleaningUp = true;
    try {
      this.logLiveEvent('cleanup', { reason, connectionEpoch: this.connectionEpoch });
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
      this.firstPcmResolver = null;
      this.firstPcmRejecter = null;
      this.setupCompleteResolver = null;
      this.audioGraphEpoch = null;
      this.activeCaptureGraphGeneration = null;
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
      eventId: `${providerEventId || context.liveSessionId || context.sessionId || 'session'}|${eventSequence ?? 'sequence-unknown'}:source:${eventType}:${String(input.text).trim()}`,
      liveSessionId: context.liveSessionId || null,
      sessionId: context.sessionId || null,
      segmentId: context.segmentId || null,
      connectionEpoch: context.connectionEpoch ?? null,
      audioTurnId: context.audioTurnId || null,
      turnKey: context.turnKey || context.audioTurnId || null,
      turnIdentitySource: context.turnIdentitySource || (context.audioTurnId ? 'local' : null),
      stream: 'source',
      eventType,
      text: String(input.text).replace(/\s+/gu, ' ').trim(),
      textMergeMode: context.inputTextMergeMode || 'initial',
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
      audioTurnId: context.audioTurnId || null,
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

function transcriptMergeMode(previousText, incomingText) {
  const previous = String(previousText || '').trim();
  const incoming = String(incomingText || '').trim();
  if (!previous || !incoming) return 'initial';
  const relation = cumulativeTextRelation(previous, incoming);
  return relation === 'extension' || relation === 'revision' || relation === 'same' ? 'snapshot' : 'append';
}

function isLikelyTranscriptContinuation(previousText, incomingText, { stream, turnIndex } = {}) {
  const previous = String(previousText || '').trim();
  const incoming = String(incomingText || '').trim();
  if (!previous || !incoming || turnIndex !== undefined && turnIndex !== null) return false;
  if (endsTranscriptSentence(previous)) return false;
  if (/^\d[\d\s,.，、]*$/u.test(incoming)) return true;
  return /[,，、:：;；]$/u.test(previous) && stream === 'source';
}

function endsTranscriptSentence(text) {
  return /[.!?。！？…]+["'”’」』）)]*$/u.test(String(text || '').trim());
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
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
    status: safeDiagnosticStatus(httpStatusFromError(rawEvent) ?? httpStatusFromError(rawError)),
    providerReason: safeDiagnosticText(rawEvent.reason || rawError.reason),
    connectionEpoch: session.connectionEpoch,
    liveSessionId: session.liveSessionId,
    segmentId: session.segmentId,
    audioCallbackCount: session.audioCallbackCount,
    audioCallbackGapCount: session.audioCallbackGapCount,
    maxAudioCallbackGapMs: session.maxAudioCallbackGapMs,
    lastAudioCallbackGapMs: session.lastAudioCallbackGapMs,
    audioCallbackGapP95Ms: percentileFromLatencyHistogram(session.audioCallbackGapHistogram),
    captureProcessorMode: session.captureProcessorMode,
    captureGraphGeneration: session.captureGraphGeneration,
    activeCaptureGraphGeneration: session.activeCaptureGraphGeneration,
    audioCaptureStage: session.audioCaptureStage,
    lastAudioCallbackType: session.lastAudioCallbackType,
    lastWorkletProcessCount: session.lastWorkletProcessCount,
    audioContextState: session.audioContext?.state || null,
    microphoneTrackState: (session.mediaStream?.getAudioTracks?.() || session.mediaStream?.getTracks?.())?.[0]?.readyState || null,
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
  if (typeof window === 'undefined' || !LIVE_DIAGNOSTICS_ENABLED) return;
  window.__liveTranslateDebug = window.__liveTranslateDebug || {};
  window.__liveTranslateDebug.getSnapshot = () => activeDebugSession?.getDebugSnapshot?.({ includeText: LIVE_EVENT_LOG_ENABLED }) || {
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
      captureProcessorMode: 'script',
      captureGraphGeneration: 0,
      activeCaptureGraphGeneration: null,
      audioCaptureStage: 'not_started',
      audioCallbackCount: 0,
      audioCallbackGapCount: 0,
      maxAudioCallbackGapMs: 0,
      lastAudioCallbackGapMs: null,
      audioCallbackGapP95Ms: 0,
      lastWorkletProcessCount: null,
      lastAudioCallbackType: null,
      audioContextState: null,
      microphoneTrackState: null,
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
    pendingInputTranscript: LIVE_EVENT_LOG_ENABLED ? '' : null,
    pendingOutputTranscript: LIVE_EVENT_LOG_ENABLED ? '' : null,
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
