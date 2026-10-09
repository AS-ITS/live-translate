const DEFAULT_TRACE_LIMIT = 20_000;
const MAX_ID_LENGTH = 256;
const TRUNCATION_MARKER = '...[truncated]';

const CONSOLE_STAGES = new Set([
  'PROVIDER_EVENT', 'TRANSCRIPT_NORMALIZED', 'TURN_ASSIGNED', 'TURN_COMPLETED',
  'SPEECH_ACTIVITY_STARTED', 'SPEECH_ACTIVITY_CONTINUED', 'LOCAL_SILENCE_DETECTED',
  'PROVIDER_RECONNECT', 'PROVIDER_ROLLOVER', 'SEGMENT_ROLLOVER',
  'EVENT_DEDUPED', 'EVENT_DROPPED', 'CUE_CREATED', 'CUE_UPDATED', 'CUE_FINALIZED',
  'SESSION_ROLLOVER_START', 'SESSION_CREATED', 'SESSION_SCOPE_SWITCHED',
  'ROLLOVER_SCHEDULED', 'ROLLOVER_COMMITTED', 'ROLLOVER_FAILED',
  'PROVIDER_SESSION_CLOSING', 'PROVIDER_SESSION_CREATING', 'PROVIDER_SESSION_READY',
  'AUTH_STATE_CHANGED', 'AUTH_PROFILE_CHECK_STARTED', 'AUTH_PROFILE_CHECK_SUCCEEDED',
  'AUTH_PROFILE_CHECK_FAILED', 'AUTH_PROFILE_CHECK_STALE',
  'LIVE_COMPONENT_MOUNTED', 'LIVE_COMPONENT_UNMOUNTED', 'RECORDING_STATE_RESET', 'ROUTE_CHANGED',
  'LOCAL_CUE_SAVED', 'VIEWER_PUBLISH_STARTED', 'VIEWER_PUBLISH_SUCCEEDED', 'VIEWER_PUBLISH_FAILED',
  'CUE_PERSIST_REQUEST', 'CUE_PERSIST_FAILED', 'CLOUD_CUE_SAVE_STARTED', 'CLOUD_CUE_SAVE_SUCCEEDED', 'CLOUD_CUE_SAVE_FAILED',
  'CHECKPOINT_REQUEST', 'CHECKPOINT_FAILED', 'CHECKPOINT_SAVE_STARTED', 'CHECKPOINT_SAVE_FAILED',
  'DURABLE_OPERATION_CREATED', 'DURABLE_OPERATION_RETRY', 'DURABLE_QUEUE_RETRYING', 'DURABLE_BARRIER_WAITING',
  'SESSION_STATE_CHANGED', 'RECORDER_GENERATION_CHANGED', 'RECORDING_PIPELINE_STATE',
  'CUE_PUBLISHED', 'VIEWER_RECEIVED', 'VIEWER_PACKET_DROPPED', 'VIEWER_STORE_UPDATED', 'REACT_RENDER',
  'WEBRTC_SIGNALING', 'WEBRTC_PEER_STATE', 'WEBRTC_DATA_CHANNEL', 'WEBRTC_CUE_PUBLISH', 'VIEWER_REALTIME',
  'WEBRTC_STATE_CHANGED', 'DATACHANNEL_STATE_CHANGED', 'REALTIME_STATE_CHANGED', 'VIEWER_SHARING_STATE_CHANGED',
  'WEBRTC_TRANSPORT_RECOVERY', 'DATA_CHANNEL_ENVELOPE_REJECTED'
]);
const REASONED_STAGES = new Set(['EVENT_DEDUPED', 'EVENT_DROPPED']);
let elapsedContext = Object.freeze({ meetingStartedAtMs: null, sessionStartedAtMs: null });

function boundedLimit(limit) {
  return Number.isInteger(limit) && limit > 0 ? Math.min(limit, DEFAULT_TRACE_LIMIT) : DEFAULT_TRACE_LIMIT;
}

function bounded(value, maxLength) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return value;
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

function safeId(value) { return bounded(value, MAX_ID_LENGTH); }
function textLength(value) { return typeof value === 'string' ? value.length : 0; }

export function createLivePipelineTrace({
  enabled = false,
  limit = DEFAULT_TRACE_LIMIT,
  now = () => new Date().toISOString(),
  nowMs = () => Date.now(),
  getElapsedContext = () => elapsedContext,
  logger = (...args) => console.debug(...args)
} = {}) {
  let isEnabled = enabled === true;
  let entries = isEnabled ? [] : null;
  let nextTraceSequence = 0;
  const maxEntries = boundedLimit(limit);

  function record(input = {}) {
    if (!isEnabled || !entries) return null;
    const stage = safeId(input.stage || 'UNKNOWN');
    const cueAction = safeId(input.cueAction);
    const reason = input.reason || input.decisionReason || input.dropReason || input.dedupeReason || null;
    const providerEventId = safeId(input.providerEventId);
    const normalizedEventId = safeId(input.normalizedEventId || (stage === 'TRANSCRIPT_NORMALIZED' ? input.eventId : null));
    let timestamp;
    try { timestamp = bounded(input.timestamp || now(), MAX_ID_LENGTH); } catch { timestamp = null; }
    let currentTimeMs = null;
    let timing = {};
    try {
      currentTimeMs = nowMs();
      timing = getElapsedContext?.() || {};
    } catch { /* Trace timing must never interrupt Live processing. */ }
    const meetingElapsedMs = elapsedFrom(input.meetingElapsedMs, timing.meetingStartedAtMs, currentTimeMs);
    const sessionElapsedMs = elapsedFrom(input.sessionElapsedMs, timing.sessionStartedAtMs, currentTimeMs);
    const entry = Object.freeze({
      traceSequence: ++nextTraceSequence,
      timestamp,
      stage,
      meetingElapsedMs,
      sessionElapsedMs,
      sessionId: safeId(input.sessionId),
      recorderSessionId: safeId(input.recorderSessionId),
      geminiSessionId: safeId(input.geminiSessionId),
      oldSessionId: safeId(input.oldSessionId),
      newSessionId: safeId(input.newSessionId),
      recordingId: safeId(input.recordingId),
      segmentId: safeId(input.segmentId),
      oldSegmentId: safeId(input.oldSegmentId),
      newSegmentId: safeId(input.newSegmentId),
      participantId: safeId(input.participantId),
      viewerId: safeId(input.viewerId),
      peerId: safeId(input.peerId),
      negotiationId: safeId(input.negotiationId),
      sourceId: safeId(input.sourceId),
      operationId: safeId(input.operationId),
      captureEpoch: input.captureEpoch ?? null,
      recorderEpoch: input.recorderEpoch ?? input.captureEpoch ?? null,
      providerEpoch: input.providerEpoch ?? null,
      connectionEpoch: input.connectionEpoch ?? null,
      generation: input.generation ?? input.connectionEpoch ?? null,
      transportGeneration: input.transportGeneration ?? input.connectionEpoch ?? null,
      snapshotGeneration: input.snapshotGeneration ?? null,
      audioTurnId: safeId(input.audioTurnId),
      providerEventId,
      normalizedEventId,
      originEventId: safeId(input.originEventId),
      providerTurnId: safeId(input.providerTurnId),
      turnKey: safeId(input.turnKey),
      cueId: safeId(input.cueId),
      meetingId: safeId(input.meetingId),
      authEvent: safeId(input.authEvent),
      recordingState: safeId(input.recordingState),
      route: safeId(input.route),
      messageType: safeId(input.messageType),
      sourcePresent: input.sourcePresent ?? null,
      translationPresent: input.translationPresent ?? null,
      rawSourcePresent: input.rawSourcePresent ?? null,
      refinedSourcePresent: input.refinedSourcePresent ?? null,
      sourceStatus: safeId(input.sourceStatus),
      translationStatus: safeId(input.translationStatus),
      sourceVersion: Number.isSafeInteger(input.sourceVersion) ? input.sourceVersion : null,
      translationVersion: Number.isSafeInteger(input.translationVersion) ? input.translationVersion : null,
      audioTurnIdPresent: input.audioTurnIdPresent ?? null,
      validatorCode: safeId(input.validatorCode),
      speechObservedSinceBoundary: input.speechObservedSinceBoundary ?? null,
      turnState: safeId(input.turnState),
      reason: safeId(REASONED_STAGES.has(stage) ? (reason || 'unspecified_reason') : reason),
      dropReason: safeId(stage === 'EVENT_DROPPED' || cueAction === 'drop' ? (input.dropReason || reason || 'unspecified_drop') : input.dropReason),
      decision: safeId(input.decision),
      eventId: safeId(input.eventId),
      eventSequence: input.eventSequence ?? null,
      attemptCount: input.attemptCount ?? null,
      sequence: input.sequence ?? null,
      revision: input.revision ?? null,
      eventType: safeId(input.eventType),
      connectionState: safeId(input.connectionState),
      iceConnectionState: safeId(input.iceConnectionState),
      signalingState: safeId(input.signalingState),
      dataChannelState: safeId(input.dataChannelState),
      realtimeState: safeId(input.realtimeState),
      persistenceState: safeId(input.persistenceState),
      channelStatus: safeId(input.channelStatus),
      receivedAt: Number.isFinite(input.receivedAt) ? input.receivedAt : null,
      lastDataChannelMessageAt: Number.isFinite(input.lastDataChannelMessageAt) ? input.lastDataChannelMessageAt : null,
      lastCueReceivedAt: Number.isFinite(input.lastCueReceivedAt) ? input.lastCueReceivedAt : null,
      lastPingAt: Number.isFinite(input.lastPingAt) ? input.lastPingAt : null,
      lastPongAt: Number.isFinite(input.lastPongAt) ? input.lastPongAt : null,
      peerCount: Number.isInteger(input.peerCount) ? input.peerCount : null,
      healthyPeerCount: Number.isInteger(input.healthyPeerCount) ? input.healthyPeerCount : null,
      signalingHealth: safeId(input.signalingHealth),
      terminalStatus: safeId(input.terminalStatus),
      terminalReason: safeId(input.terminalReason),
      localFinalize: Boolean(input.localFinalize),
      isTerminalReplay: Boolean(input.isTerminalReplay),
      isFinal: Boolean(input.isFinal),
      isLateTranscript: Boolean(input.isLateTranscript),
      turnComplete: Boolean(input.turnComplete),
      generationComplete: Boolean(input.generationComplete),
      providerTurnIndex: input.providerTurnIndex ?? null,
      turnIdentitySource: safeId(input.turnIdentitySource),
      sourceTextLength: textLength(input.sourceText),
      translationTextLength: textLength(input.translationText),
      beforeSourceTextLength: textLength(input.beforeSourceText),
      afterSourceTextLength: textLength(input.afterSourceText),
      beforeTranslationTextLength: textLength(input.beforeTranslationText),
      afterTranslationTextLength: textLength(input.afterTranslationText),
      cueAction,
      pcmSequence: input.pcmSequence ?? null,
      pcmBytes: input.pcmBytes ?? null,
      pcmSampleCount: Number.isFinite(input.pcmSampleCount) ? input.pcmSampleCount : null,
      pcmDurationMs: Number.isFinite(input.pcmDurationMs) ? input.pcmDurationMs : null,
      pcmCaptureTimestampMs: Number.isFinite(input.pcmCaptureTimestampMs) ? input.pcmCaptureTimestampMs : null,
      transportResult: safeId(input.transportResult),
      httpStatus: Number.isInteger(input.httpStatus) ? input.httpStatus : null,
      serverErrorCode: safeId(input.serverErrorCode),
      errorCode: safeId(input.errorCode || input.serverErrorCode),
      durationMs: Number.isFinite(input.durationMs) ? Math.max(0, input.durationMs) : null,
      queueDepth: Number.isInteger(input.queueDepth) ? Math.max(0, input.queueDepth) : null,
      inFlight: Number.isInteger(input.inFlight) ? Math.max(0, input.inFlight) : null,
      retryAttempt: Number.isInteger(input.retryAttempt) ? Math.max(0, input.retryAttempt) : null,
      rolloverGeneration: Number.isInteger(input.rolloverGeneration) ? Math.max(0, input.rolloverGeneration) : null,
      authoritativeSegmentId: safeId(input.authoritativeSegmentId)
    });
    entries.push(entry);
    if (entries.length > maxEntries) entries.splice(0, entries.length - maxEntries);
    if (CONSOLE_STAGES.has(entry.stage) || entry.cueAction === 'drop') {
      try { logger('[TURN TRACE]', entry); } catch { /* Diagnostics cannot interrupt Live processing. */ }
    }
    return entry;
  }

  function get(filter = {}) {
    if (!entries) return [];
    return entries
      .filter((entry) => Object.entries(filter).every(([key, value]) => value === undefined || value === null || entry[key] === value))
      .map((entry) => ({ ...entry }));
  }

  function getTurn(audioTurnId) { return audioTurnId ? get({ audioTurnId }) : []; }
  function clear() {
    if (entries) entries.length = 0;
    nextTraceSequence = 0;
  }
  function exportJson() {
    const exportedAt = safeId(now());
    const exportedEntries = get();
    return JSON.stringify({ exportedAt, entryCount: exportedEntries.length, entries: exportedEntries }, null, 2);
  }
  function setEnabled(enabledValue) {
    isEnabled = enabledValue === true;
    entries = isEnabled ? [] : null;
    nextTraceSequence = 0;
    return isEnabled;
  }

  return Object.freeze({ record, get, getTurn, clear, exportJson, setEnabled, isEnabled: () => isEnabled });
}

export const livePipelineTrace = createLivePipelineTrace();
export function configureLivePipelineTrace(enabled) { return livePipelineTrace.setEnabled(enabled === true); }
export function recordLivePipelineTrace(entry) { return livePipelineTrace.record(entry); }

export function configureLivePipelineElapsedContext({ meetingStartedAt, sessionStartedAt } = {}) {
  elapsedContext = Object.freeze({
    meetingStartedAtMs: normalizedTimestamp(meetingStartedAt),
    sessionStartedAtMs: normalizedTimestamp(sessionStartedAt)
  });
  return elapsedContext;
}

export function updateLivePipelineSessionStartedAt(sessionStartedAt) {
  elapsedContext = Object.freeze({
    ...elapsedContext,
    sessionStartedAtMs: normalizedTimestamp(sessionStartedAt)
  });
  return elapsedContext;
}

function elapsedFrom(explicitValue, startedAtMs, currentTimeMs) {
  if (Number.isFinite(explicitValue)) return Math.max(0, explicitValue);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(currentTimeMs)) return null;
  return Math.max(0, currentTimeMs - startedAtMs);
}

function normalizedTimestamp(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
