import { isSessionStatus } from '../domain/session/index.js';

const TERMINAL_STATUSES = new Set(['completed', 'stopped', 'failed', 'expired']);
const EMPTY_TRANSCRIPT_SUMMARY = Object.freeze({
  totalItems: 0,
  sourceFinalCount: 0,
  translationFinalCount: 0,
  sourcePartialCount: 0,
  translationPartialCount: 0,
  hasTranscript: false
});

export function createSessionRecord(input = {}, options = {}) {
  const now = resolveNow(options.now);
  const id = input.id || resolveId(options.idFactory);

  return {
    id,
    ...(Object.hasOwn(input, 'name') ? { name: input.name || null } : {}),
    startedAt: input.startedAt,
    endedAt: null,
    durationMs: null,
    targetLanguageCode: input.targetLanguageCode,
    targetLanguageLabel: input.targetLanguageLabel || null,
    sourceLanguageCode: input.sourceLanguageCode || null,
    ...(Object.hasOwn(input, 'echoTargetLanguage') ? { echoTargetLanguage: input.echoTargetLanguage !== false } : {}),
    ...(Object.hasOwn(input, 'shouldRecordInputAudio') ? { shouldRecordInputAudio: input.shouldRecordInputAudio === true } : {}),
    meetingId: input.meetingId || null,
    segmentId: input.segmentId || null,
    ...(Object.hasOwn(input, 'meetingGlossaryEntries')
      ? { meetingGlossaryEntries: Array.isArray(input.meetingGlossaryEntries) ? input.meetingGlossaryEntries.map(clonePlain) : [] }
      : {}),
    ...(Object.hasOwn(input, 'segments') ? { segments: Array.isArray(input.segments) ? input.segments.map(clonePlain) : [] } : {}),
    status: input.status || 'active',
    failureReason: null,
    failureCategory: null,
    failureDiagnostics: sanitizeFailureDiagnostics(input.failureDiagnostics),
    lastLifecycleState: 'listening',
    selectedInputDeviceId: input.selectedInputDeviceId || null,
    inputDeviceLabelSnapshot: input.inputDeviceLabelSnapshot || null,
    audioArtifacts: sanitizeAudioArtifacts(input.audioArtifacts),
    transcriptSummary: summarizeTranscriptItems(input.transcriptItems || []),
    createdAt: now,
    updatedAt: now
  };
}

function sanitizeAudioArtifacts(artifacts = {}) {
  const result = {};
  for (const kind of ['input', 'translation']) {
    const artifact = artifacts?.[kind];
    if (artifact && typeof artifact === 'object' && !Array.isArray(artifact)) {
      result[kind] = { ...artifact, kind };
    }
  }
  return result;
}

function sanitizeFailureDiagnostics(diagnostics) {
  if (!Array.isArray(diagnostics)) return [];
  return diagnostics
    .filter((diagnostic) => diagnostic && typeof diagnostic === 'object' && !Array.isArray(diagnostic))
    .slice(-10)
    .map((diagnostic) => ({
      at: typeof diagnostic.at === 'string' || typeof diagnostic.at === 'number' ? diagnostic.at : null,
      source: typeof diagnostic.source === 'string' ? diagnostic.source.slice(0, 80) : 'unknown',
      stage: typeof diagnostic.stage === 'string' ? diagnostic.stage.slice(0, 80) : null,
      reason: typeof diagnostic.reason === 'string' ? diagnostic.reason.slice(0, 80) : 'unknown_error',
      category: typeof diagnostic.category === 'string' ? diagnostic.category.slice(0, 80) : null,
      code: typeof diagnostic.code === 'string' || typeof diagnostic.code === 'number' ? diagnostic.code : null,
      status: Number.isInteger(diagnostic.status) ? diagnostic.status : null,
      connectionEpoch: Number.isInteger(diagnostic.connectionEpoch) ? diagnostic.connectionEpoch : null,
      liveSessionId: typeof diagnostic.liveSessionId === 'string' ? diagnostic.liveSessionId.slice(0, 160) : null,
      segmentId: typeof diagnostic.segmentId === 'string' ? diagnostic.segmentId.slice(0, 160) : null,
      audioCallbackCount: Number.isInteger(diagnostic.audioCallbackCount) ? diagnostic.audioCallbackCount : null,
      pcmSendAttemptCount: Number.isInteger(diagnostic.pcmSendAttemptCount) ? diagnostic.pcmSendAttemptCount : null,
      pcmSendSyncThrowCount: Number.isInteger(diagnostic.pcmSendSyncThrowCount) ? diagnostic.pcmSendSyncThrowCount : null,
      pcmSendAsyncRejectCount: Number.isInteger(diagnostic.pcmSendAsyncRejectCount) ? diagnostic.pcmSendAsyncRejectCount : null
    }));
}

function clonePlain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export function updateSessionRecord(record, patch = {}, options = {}) {
  const updatedAt = resolveNow(options.now);

  if (patch.status !== undefined && patch.status !== record.status) {
    const from = record.status === 'completed' ? 'stopped' : record.status;
    const to = patch.status === 'completed' ? 'stopped' : patch.status;
    // Preserve older lifecycle-only values such as `reconnecting`; enforce
    // transitions only when both sides use the Session aggregate status model.
    if (!isSessionStatus(from) || !isSessionStatus(to)) return {
      ...record,
      ...patch,
      failureDiagnostics: patch.failureDiagnostics === undefined
        ? sanitizeFailureDiagnostics(record.failureDiagnostics)
        : sanitizeFailureDiagnostics(patch.failureDiagnostics),
      id: record.id,
      createdAt: record.createdAt,
      updatedAt
    };
    const allowed = {
      created: ['active', 'failed'],
      active: ['paused', 'stopped', 'failed', 'expired'],
      paused: ['active', 'stopped', 'failed', 'expired'],
      stopped: [], failed: [], expired: []
    };
    if (!allowed[from]?.includes(to)) {
      throw new RangeError(`Session status transition from ${record.status} to ${patch.status} is not allowed`);
    }
  }

  return {
    ...record,
    ...patch,
    ...(patch.failureDiagnostics !== undefined
      ? { failureDiagnostics: sanitizeFailureDiagnostics(patch.failureDiagnostics) }
      : { failureDiagnostics: sanitizeFailureDiagnostics(record.failureDiagnostics) }),
    id: record.id,
    createdAt: record.createdAt,
    updatedAt
  };
}

export function finalizeSessionRecord(record, patch = {}, options = {}) {
  if (!['active', 'paused'].includes(record.status)) {
    throw new Error('Cannot finalize a non-active session record.');
  }

  const endedAt = patch.endedAt ?? resolveNow(options.now);
  const status = patch.status || 'completed';

  if (!isTerminalSessionStatus(status)) {
    throw new Error(`Cannot finalize session record with non-terminal status: ${status}`);
  }

  return {
    ...record,
    ...patch,
    failureDiagnostics: patch.failureDiagnostics === undefined
      ? sanitizeFailureDiagnostics(record.failureDiagnostics)
      : sanitizeFailureDiagnostics(patch.failureDiagnostics),
    id: record.id,
    createdAt: record.createdAt,
    status,
    endedAt,
    durationMs: durationBetween(record.startedAt, endedAt),
    failureReason: patch.failureReason ?? record.failureReason,
    failureCategory: patch.failureCategory ?? record.failureCategory,
    transcriptSummary: patch.transcriptSummary ?? record.transcriptSummary,
    updatedAt: resolveNow(options.now, endedAt)
  };
}

export function createTranscriptItemForSession(sessionId, transcriptItem = {}) {
  const mapped = {
    id: transcriptItem.id,
    sessionId,
    ...(transcriptItem.segmentId ? { segmentId: transcriptItem.segmentId } : {}),
    stream: transcriptItem.stream,
    status: transcriptItem.status,
    text: transcriptItem.text,
    ...(transcriptItem.rawText === undefined ? {} : { rawText: transcriptItem.rawText }),
    sequence: transcriptItem.sequence,
    startedAt: transcriptItem.startedAt,
    finalizedAt: transcriptItem.finalizedAt
  };

  const withLanguageCode = transcriptItem.languageCode ? { ...mapped, languageCode: transcriptItem.languageCode } : mapped;

  if (transcriptItem.stream !== 'source' || transcriptItem.sourceLanguageDetection === undefined) {
    return withLanguageCode;
  }

  return {
    ...withLanguageCode,
    sourceLanguageDetection: cloneSourceLanguageDetection(transcriptItem.sourceLanguageDetection)
  };
}

export function summarizeTranscriptItems(items = []) {
  return items.reduce(
    (summary, item) => {
      const next = {
        ...summary,
        totalItems: summary.totalItems + 1,
        hasTranscript: summary.hasTranscript || hasTranscriptText(item)
      };

      if (item.stream === 'source' && item.status === 'final') {
        return { ...next, sourceFinalCount: next.sourceFinalCount + 1 };
      }
      if (item.stream === 'translation' && item.status === 'final') {
        return { ...next, translationFinalCount: next.translationFinalCount + 1 };
      }
      if (item.stream === 'source' && item.status === 'partial') {
        return { ...next, sourcePartialCount: next.sourcePartialCount + 1 };
      }
      if (item.stream === 'translation' && item.status === 'partial') {
        return { ...next, translationPartialCount: next.translationPartialCount + 1 };
      }

      return next;
    },
    { ...EMPTY_TRANSCRIPT_SUMMARY }
  );
}

export function isTerminalSessionStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

function resolveNow(now, fallback) {
  if (typeof now === 'function') {
    return now();
  }
  if (now !== undefined) {
    return now;
  }
  if (fallback !== undefined) {
    return fallback;
  }

  return Date.now();
}

function resolveId(idFactory) {
  if (typeof idFactory === 'function') {
    return idFactory();
  }

  return `session-${Date.now()}`;
}

function durationBetween(startedAt, endedAt) {
  if (Number.isFinite(startedAt) && Number.isFinite(endedAt)) {
    return Math.max(0, endedAt - startedAt);
  }

  const startMs = Date.parse(startedAt);
  const endMs = Date.parse(endedAt);

  if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
    return Math.max(0, endMs - startMs);
  }

  return null;
}

function hasTranscriptText(item) {
  return typeof item.text === 'string' && item.text.length > 0;
}

function cloneSourceLanguageDetection(detection) {
  if (!detection || typeof detection !== 'object' || Array.isArray(detection)) {
    return detection;
  }

  return {
    ...detection,
    ...(Array.isArray(detection.detectedLanguageCodes)
      ? { detectedLanguageCodes: [...detection.detectedLanguageCodes] }
      : {})
  };
}
