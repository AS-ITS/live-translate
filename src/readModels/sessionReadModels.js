const TERMINAL_SESSION_STATUSES = new Set(['completed', 'stopped', 'failed', 'expired']);
const EMPTY_TRANSCRIPT_SUMMARY = Object.freeze({
  totalItems: 0,
  sourceFinalCount: 0,
  translationFinalCount: 0,
  sourcePartialCount: 0,
  translationPartialCount: 0,
  hasTranscript: false
});
const UNKNOWN_TARGET_LANGUAGE_CODE = 'unknown-language';

export function mapSessionRecordToHistoryListItem(sessionRecord = {}) {
  return {
    id: sessionRecord.id,
    status: sessionRecord.status,
    startedAt: sessionRecord.startedAt ?? null,
    endedAt: sessionRecord.endedAt ?? null,
    durationMs: sessionRecord.durationMs ?? null,
    targetLanguageCode: sessionRecord.targetLanguageCode ?? null,
    targetLanguageLabel: sessionRecord.targetLanguageLabel ?? null,
    failureReason: sessionRecord.failureReason ?? null,
    failureCategory: sessionRecord.failureCategory ?? null,
    transcriptSummary: copyTranscriptSummary(sessionRecord.transcriptSummary),
    legacy: true
  };
}

export function mapSessionRecordDetailToDTO(detail = {}) {
  const sessionRecord = detail?.sessionRecord || {};
  const sessionId = sessionRecord.id;
  const items = Array.isArray(detail?.transcriptItems) ? detail.transcriptItems : [];
  const sourceItems = finalItemsForStream(items, 'source');
  const translationItems = finalItemsForStream(items, 'translation');
  const sourceRevisionId = `source-revision:${sessionId}:final`;
  const sourceTranscript = {
    id: `source:${sessionId}`,
    sessionId,
    revisionId: sourceRevisionId,
    status: mapSourceTranscriptStatus(sessionRecord.status),
    items: sourceItems,
    createdAt: sessionRecord.startedAt ?? null,
    finalizedAt: sessionRecord.endedAt ?? null,
    legacy: true
  };
  const translationOutputs = buildLegacyTranslationOutputs(sessionRecord, sourceRevisionId, translationItems);

  return {
    session: mapSessionRecordToDetailSession(sessionRecord),
    sourceTranscript,
    translationOutputs,
    selectedTranslationOutput: translationOutputs[0] || null,
    legacy: true
  };
}

function mapSessionRecordToDetailSession(sessionRecord) {
  return {
    id: sessionRecord.id,
    status: sessionRecord.status,
    startedAt: sessionRecord.startedAt ?? null,
    endedAt: sessionRecord.endedAt ?? null,
    durationMs: sessionRecord.durationMs ?? null,
    failureReason: sessionRecord.failureReason ?? null,
    failureCategory: sessionRecord.failureCategory ?? null,
    selectedInputDeviceId: sessionRecord.selectedInputDeviceId ?? null,
    inputDeviceLabelSnapshot: sessionRecord.inputDeviceLabelSnapshot ?? null,
    transcriptSummary: copyTranscriptSummary(sessionRecord.transcriptSummary)
  };
}

function buildLegacyTranslationOutputs(sessionRecord, sourceRevisionId, translationItems) {
  if (translationItems.length === 0) {
    return [];
  }

  const sessionId = sessionRecord.id;
  const targetLanguageCode = sessionRecord.targetLanguageCode ?? UNKNOWN_TARGET_LANGUAGE_CODE;

  return [
    {
      id: `legacy-output:${sessionId}:${targetLanguageCode}`,
      translationRequestId: `legacy-request:${sessionId}:${targetLanguageCode}`,
      sessionId,
      sourceTranscriptRevisionId: sourceRevisionId,
      targetLanguageCode,
      targetLanguageLabel: sessionRecord.targetLanguageLabel ?? null,
      status: 'completed',
      items: translationItems,
      provider: null,
      model: null,
      providerMetadataAvailable: false,
      createdAt: sessionRecord.startedAt ?? null,
      completedAt: sessionRecord.endedAt ?? null,
      legacy: true
    }
  ];
}

function finalItemsForStream(items, stream) {
  return items
    .filter((item) => item?.stream === stream && item.status === 'final')
    .map(copyTranscriptItem)
    .sort(compareBySequence);
}

function copyTranscriptItem(item) {
  return { ...item };
}

function compareBySequence(first, second) {
  return sequenceValue(first) - sequenceValue(second);
}

function sequenceValue(item) {
  return Number.isFinite(item?.sequence) ? item.sequence : 0;
}

function mapSourceTranscriptStatus(sessionStatus) {
  return TERMINAL_SESSION_STATUSES.has(sessionStatus) ? 'finalized' : 'active';
}

function copyTranscriptSummary(summary) {
  return summary ? { ...summary } : { ...EMPTY_TRANSCRIPT_SUMMARY };
}
