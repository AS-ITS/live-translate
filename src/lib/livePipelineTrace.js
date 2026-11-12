const DEFAULT_TRACE_LIMIT = 20_000;
const MAX_ID_LENGTH = 256;
const TRUNCATION_MARKER = '...[truncated]';
const TRACE_SCHEMA_VERSION = 'live-pipeline-trace/v1';
const SAFE_ROLES = new Set(['recorder', 'viewer', 'system']);
const SENSITIVE_VALUE_PATTERNS = Object.freeze([
  /\bBearer\s+\S+/giu,
  /\bAIza[0-9A-Za-z_-]{20,}\b/gu,
  /\beyJ[0-9A-Za-z_-]+\.[0-9A-Za-z_-]+\.[0-9A-Za-z_-]+\b/gu,
  /\bcandidate:[^\s]+(?:\s+[^\s]+){4,}/giu,
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/gu,
  /(?:^|\s)v=0(?:\s|$)/giu
]);

const CONSOLE_STAGES = new Set([
  'PROVIDER_EVENT', 'TRANSCRIPT_NORMALIZED', 'TURN_ASSIGNED', 'TURN_COMPLETED',
  'SPEECH_ACTIVITY_STARTED', 'SPEECH_ACTIVITY_CONTINUED', 'LOCAL_SILENCE_DETECTED',
  'PROVIDER_RECONNECT', 'PROVIDER_ROLLOVER', 'SEGMENT_ROLLOVER',
  'EVENT_DEDUPED', 'EVENT_DROPPED', 'CUE_CREATED', 'CUE_UPDATED', 'CUE_FINALIZED',
  'SESSION_ROLLOVER_START', 'SESSION_CREATED', 'SESSION_SCOPE_SWITCHED',
  'ROLLOVER_SCHEDULED', 'ROLLOVER_COMMITTED', 'ROLLOVER_FAILED',
  'PROVIDER_SESSION_CLOSING', 'PROVIDER_SESSION_CREATING', 'PROVIDER_SESSION_READY',
  'PROVIDER_RECOVERY_ATTEMPT', 'PROVIDER_RECOVERY_FAILED', 'PROVIDER_RECOVERY_EXHAUSTED', 'PROVIDER_RECOVERY_CANCELLED',
  'AUTH_STATE_CHANGED', 'AUTH_PROFILE_CHECK_STARTED', 'AUTH_PROFILE_CHECK_SUCCEEDED',
  'AUTH_PROFILE_CHECK_FAILED', 'AUTH_PROFILE_CHECK_STALE',
  'LIVE_COMPONENT_MOUNTED', 'LIVE_COMPONENT_UNMOUNTED', 'RECORDING_STATE_RESET', 'ROUTE_CHANGED',
  'LOCAL_CUE_SAVED', 'VIEWER_PUBLISH_STARTED', 'VIEWER_PUBLISH_SUCCEEDED', 'VIEWER_PUBLISH_FAILED',
  'CUE_PERSIST_REQUEST', 'CUE_PERSIST_FAILED', 'CLOUD_CUE_SAVE_STARTED', 'CLOUD_CUE_SAVE_SUCCEEDED', 'CLOUD_CUE_SAVE_FAILED',
  'CHECKPOINT_REQUEST', 'CHECKPOINT_FAILED', 'CHECKPOINT_SAVE_STARTED', 'CHECKPOINT_SAVE_FAILED',
  'DURABLE_OPERATION_CREATED', 'DURABLE_OPERATION_RETRY', 'DURABLE_QUEUE_RETRYING', 'DURABLE_BARRIER_WAITING',
  'SESSION_STATE_CHANGED', 'RECORDER_GENERATION_CHANGED', 'RECORDING_PIPELINE_STATE',
  'GLOSSARY_SAVE_ACCEPTED', 'GLOSSARY_REVISION_UPDATED', 'CONTINUE_REQUESTED',
  'CONTINUE_BARRIER_COMPLETE', 'RESUME_SEGMENT_CONFIRMED', 'TOKEN_SEGMENT_BOUND', 'PROVIDER_CONFIGURED',
  'CORRECTION_CONFIGURED', 'CONTINUE_PROVIDER_READY', 'CONTINUE_AUDIO_RESUMED', 'CONTINUE_READY', 'CONTINUE_CONFIGURATION_FAILED',
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
function safeDiagnosticValue(value) {
  const boundedValue = safeId(value);
  if (typeof boundedValue !== 'string') return boundedValue;
  return SENSITIVE_VALUE_PATTERNS.reduce((result, pattern) => result.replace(pattern, '[redacted]'), boundedValue);
}
function safeRole(value, stage) {
  if (SAFE_ROLES.has(value)) return value;
  if (['VIEWER_RECEIVED', 'VIEWER_PACKET_DROPPED', 'VIEWER_STORE_UPDATED', 'VIEWER_REALTIME', 'REACT_RENDER', 'VIEWER_SNAPSHOT', 'VIEWER_MEETING_LIFECYCLE'].includes(stage)) return 'viewer';
  if (['AUTH_STATE_CHANGED', 'AUTH_PROFILE_CHECK_STARTED', 'AUTH_PROFILE_CHECK_SUCCEEDED', 'AUTH_PROFILE_CHECK_FAILED', 'AUTH_PROFILE_CHECK_STALE', 'ROUTE_CHANGED'].includes(stage)) return 'system';
  return 'recorder';
}
function safeEvent(input, stage) {
  return safeDiagnosticValue(input.event || (input.eventType ? `${stage}.${input.eventType}` : stage));
}
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
  const maxEntries = boundedLimit(limit);
  let entries = isEnabled ? new Array(maxEntries) : null;
  let entryStart = 0;
  let entryCount = 0;
  let droppedCount = 0;
  let nextTraceSequence = 0;

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
      role: safeRole(input.role, stage),
      event: safeEvent(input, stage),
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
      chunkId: safeId(input.chunkId),
      captureEpoch: input.captureEpoch ?? null,
      recorderEpoch: input.recorderEpoch ?? input.captureEpoch ?? null,
      providerEpoch: input.providerEpoch ?? null,
      connectionEpoch: input.connectionEpoch ?? null,
      generation: input.generation ?? input.connectionEpoch ?? input.recorderEpoch ?? input.captureEpoch ?? null,
      transportGeneration: input.transportGeneration ?? input.connectionEpoch ?? null,
      snapshotGeneration: input.snapshotGeneration ?? null,
      reconnectAttempt: Number.isSafeInteger(input.reconnectAttempt) ? input.reconnectAttempt : null,
      reconnectReason: safeDiagnosticValue(input.reconnectReason),
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
      meetingStatus: safeId(input.meetingStatus),
      lifecycleStatus: safeId(input.lifecycleStatus),
      route: safeId(input.route),
      visibilityState: safeId(input.visibilityState),
      pagePersisted: typeof input.pagePersisted === 'boolean' ? input.pagePersisted : null,
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
      reason: safeDiagnosticValue(REASONED_STAGES.has(stage) ? (reason || 'unspecified_reason') : reason),
      dropReason: safeDiagnosticValue(stage === 'EVENT_DROPPED' || cueAction === 'drop' ? (input.dropReason || reason || 'unspecified_drop') : input.dropReason),
      decision: safeDiagnosticValue(input.decision),
      eventId: safeId(input.eventId),
      eventSequence: input.eventSequence ?? null,
      signalSequence: Number.isSafeInteger(input.signalSequence) ? input.signalSequence : null,
      signalingCursorBefore: Number.isSafeInteger(input.signalingCursorBefore) ? input.signalingCursorBefore : null,
      signalingCursorAfter: Number.isSafeInteger(input.signalingCursorAfter) ? input.signalingCursorAfter : null,
      signalMessageCount: Number.isInteger(input.signalMessageCount) ? Math.max(0, input.signalMessageCount) : null,
      participantTtlMs: Number.isFinite(input.participantTtlMs) ? Math.max(0, input.participantTtlMs) : null,
      messageExpiresAt: Number.isFinite(input.messageExpiresAt) ? input.messageExpiresAt : null,
      attemptCount: input.attemptCount ?? null,
      sequence: input.sequence ?? null,
      lastReceivedCueSequence: Number.isSafeInteger(input.lastReceivedCueSequence) ? input.lastReceivedCueSequence : null,
      revision: input.revision ?? null,
      snapshotRevision: input.snapshotRevision ?? null,
      cueCount: Number.isInteger(input.cueCount) ? Math.max(0, input.cueCount) : null,
      lifecycleVersion: Number.isSafeInteger(input.lifecycleVersion) ? input.lifecycleVersion : null,
      glossaryEntryCount: Number.isSafeInteger(input.glossaryEntryCount) ? input.glossaryEntryCount : null,
      eventType: safeId(input.eventType),
      cueDeliverySource: safeId(input.cueDeliverySource),
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
      recoveryAttemptState: safeId(input.recoveryAttemptState),
      retryCounterSemantics: safeId(input.retryCounterSemantics),
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
      serverErrorCode: safeDiagnosticValue(input.serverErrorCode),
      errorCode: safeDiagnosticValue(input.errorCode || input.serverErrorCode),
      durationMs: Number.isFinite(input.durationMs) ? Math.max(0, input.durationMs) : null,
      continueElapsedMs: Number.isFinite(input.continueElapsedMs) ? Math.max(0, input.continueElapsedMs) : null,
      queueDepth: Number.isInteger(input.queueDepth) ? Math.max(0, input.queueDepth) : null,
      inFlight: Number.isInteger(input.inFlight) ? Math.max(0, input.inFlight) : null,
      retryAttempt: Number.isInteger(input.retryAttempt) ? Math.max(0, input.retryAttempt) : null,
      rolloverGeneration: Number.isInteger(input.rolloverGeneration) ? Math.max(0, input.rolloverGeneration) : null,
      authoritativeSegmentId: safeId(input.authoritativeSegmentId)
    });
    if (entryCount < maxEntries) {
      entries[(entryStart + entryCount) % maxEntries] = entry;
      entryCount += 1;
    } else {
      entries[entryStart] = entry;
      entryStart = (entryStart + 1) % maxEntries;
      droppedCount += 1;
    }
    if (CONSOLE_STAGES.has(entry.stage) || entry.cueAction === 'drop') {
      try { logger('[TURN TRACE]', entry); } catch { /* Diagnostics cannot interrupt Live processing. */ }
    }
    return entry;
  }

  function get(filter = {}) {
    if (!entries) return [];
    return Array.from({ length: entryCount }, (_, index) => entries[(entryStart + index) % maxEntries])
      .filter((entry) => Object.entries(filter).every(([key, value]) => value === undefined || value === null || entry[key] === value))
      .map((entry) => ({ ...entry }));
  }

  function getTurn(audioTurnId) { return audioTurnId ? get({ audioTurnId }) : []; }
  function clear() {
    if (entries) entries = new Array(maxEntries);
    entryStart = 0;
    entryCount = 0;
    droppedCount = 0;
    nextTraceSequence = 0;
  }
  function exportJson() {
    const exportedAt = safeId(now());
    const exportedEntries = get();
    return JSON.stringify({
      schemaVersion: TRACE_SCHEMA_VERSION,
      exportedAt,
      capacity: maxEntries,
      droppedCount,
      entryCount: exportedEntries.length,
      entries: exportedEntries
    }, null, 2);
  }
  function setEnabled(enabledValue) {
    isEnabled = enabledValue === true;
    entries = isEnabled ? new Array(maxEntries) : null;
    entryStart = 0;
    entryCount = 0;
    droppedCount = 0;
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
