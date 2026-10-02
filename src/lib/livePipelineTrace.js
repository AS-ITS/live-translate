const DEFAULT_TRACE_LIMIT = 20_000;
const MAX_TEXT_LENGTH = 512;
const MAX_ID_LENGTH = 256;
const TRUNCATION_MARKER = '...[truncated]';

const CONSOLE_STAGES = new Set([
  'PROVIDER_EVENT', 'TRANSCRIPT_NORMALIZED', 'TURN_ASSIGNED', 'TURN_COMPLETED',
  'SPEECH_ACTIVITY_STARTED', 'SPEECH_ACTIVITY_CONTINUED', 'LOCAL_SILENCE_DETECTED',
  'PROVIDER_RECONNECT', 'PROVIDER_ROLLOVER', 'SEGMENT_ROLLOVER',
  'EVENT_DEDUPED', 'EVENT_DROPPED', 'CUE_CREATED', 'CUE_UPDATED', 'CUE_FINALIZED',
  'CUE_PUBLISHED', 'VIEWER_RECEIVED', 'REACT_RENDER'
]);
const REASONED_STAGES = new Set(['EVENT_DEDUPED', 'EVENT_DROPPED']);

function boundedLimit(limit) {
  return Number.isInteger(limit) && limit > 0 ? Math.min(limit, DEFAULT_TRACE_LIMIT) : DEFAULT_TRACE_LIMIT;
}

function bounded(value, maxLength) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return value;
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

function safeId(value) { return bounded(value, MAX_ID_LENGTH); }
function safeText(value) { return bounded(value, MAX_TEXT_LENGTH) || ''; }

export function createLivePipelineTrace({
  enabled = false,
  limit = DEFAULT_TRACE_LIMIT,
  now = () => new Date().toISOString(),
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
    const entry = Object.freeze({
      traceSequence: ++nextTraceSequence,
      timestamp,
      stage,
      recordingId: safeId(input.recordingId),
      segmentId: safeId(input.segmentId),
      captureEpoch: input.captureEpoch ?? null,
      providerEpoch: input.providerEpoch ?? null,
      connectionEpoch: input.connectionEpoch ?? null,
      audioTurnId: safeId(input.audioTurnId),
      providerEventId,
      normalizedEventId,
      originEventId: safeId(input.originEventId),
      providerTurnId: safeId(input.providerTurnId),
      turnKey: safeId(input.turnKey),
      cueId: safeId(input.cueId),
      sourceStatus: safeId(input.sourceStatus),
      translationStatus: safeId(input.translationStatus),
      speechObservedSinceBoundary: input.speechObservedSinceBoundary ?? null,
      turnState: safeId(input.turnState),
      reason: safeId(REASONED_STAGES.has(stage) ? (reason || 'unspecified_reason') : reason),
      dropReason: safeId(stage === 'EVENT_DROPPED' || cueAction === 'drop' ? (input.dropReason || reason || 'unspecified_drop') : input.dropReason),
      decision: safeId(input.decision),
      eventId: safeId(input.eventId),
      eventSequence: input.eventSequence ?? null,
      eventType: safeId(input.eventType),
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
      sourceText: safeText(input.sourceText),
      translationText: safeText(input.translationText),
      beforeSourceText: safeText(input.beforeSourceText),
      afterSourceText: safeText(input.afterSourceText),
      beforeTranslationText: safeText(input.beforeTranslationText),
      afterTranslationText: safeText(input.afterTranslationText),
      cueAction,
      pcmSequence: input.pcmSequence ?? null,
      pcmBytes: input.pcmBytes ?? null,
      transportResult: safeId(input.transportResult)
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
