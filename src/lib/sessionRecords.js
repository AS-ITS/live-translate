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
    startedAt: input.startedAt,
    endedAt: null,
    durationMs: null,
    targetLanguageCode: input.targetLanguageCode,
    targetLanguageLabel: input.targetLanguageLabel || null,
    sourceLanguageCode: input.sourceLanguageCode || null,
    status: 'active',
    failureReason: null,
    failureCategory: null,
    lastLifecycleState: 'listening',
    selectedInputDeviceId: input.selectedInputDeviceId || null,
    inputDeviceLabelSnapshot: input.inputDeviceLabelSnapshot || null,
    transcriptSummary: summarizeTranscriptItems(input.transcriptItems || []),
    createdAt: now,
    updatedAt: now
  };
}

export function updateSessionRecord(record, patch = {}, options = {}) {
  const updatedAt = resolveNow(options.now);

  return {
    ...record,
    ...patch,
    id: record.id,
    createdAt: record.createdAt,
    updatedAt
  };
}

export function finalizeSessionRecord(record, patch = {}, options = {}) {
  if (record.status !== 'active') {
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
    stream: transcriptItem.stream,
    status: transcriptItem.status,
    text: transcriptItem.text,
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
