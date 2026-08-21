import { buildTranscriptArticleParagraphs, formatTranscriptArticleText } from '../lib/transcript.js';
import { sanitizeAudioArtifactsForDTO } from '../infrastructure/sessionAudioArtifacts.js';

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
    ...(sessionRecord.meetingId != null ? { meetingId: sessionRecord.meetingId } : {}),
    ...(sessionRecord.name !== undefined ? { name: sessionRecord.name } : {}),
    status: sessionRecord.status,
    startedAt: sessionRecord.startedAt ?? null,
    endedAt: sessionRecord.endedAt ?? null,
    durationMs: sessionRecord.durationMs ?? null,
    targetLanguageCode: sessionRecord.targetLanguageCode ?? null,
    targetLanguageLabel: sessionRecord.targetLanguageLabel ?? null,
    sourceLanguageCode: sessionRecord.sourceLanguageCode ?? null,
    failureReason: sessionRecord.failureReason ?? null,
    failureCategory: sessionRecord.failureCategory ?? null,
    transcriptSummary: copyTranscriptSummary(sessionRecord.transcriptSummary),
    recordKind: sessionRecord.recordKind ?? 'session',
    retranslatedFrom: copyRetranslationProvenance(sessionRecord.retranslatedFrom),
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
  const selectedTranslationOutput = translationOutputs[0] || null;

  return {
    session: mapSessionRecordToDetailSession(sessionRecord),
    cues: Array.isArray(detail?.cues) ? detail.cues.filter((cue) => cue?.status === 'final').map((cue) => ({ ...cue })) : [],
    sourceTranscript,
    translationOutputs,
    selectedTranslationOutput,
    readingContent: buildReadingContent({
      sessionRecord,
      sourceTranscript,
      selectedTranslationOutput,
      sourceItems,
      translationItems
    }),
    legacy: true
  };
}

function mapSessionRecordToDetailSession(sessionRecord) {
  return {
    id: sessionRecord.id,
    ...(sessionRecord.name !== undefined ? { name: sessionRecord.name } : {}),
    status: sessionRecord.status,
    startedAt: sessionRecord.startedAt ?? null,
    endedAt: sessionRecord.endedAt ?? null,
    durationMs: sessionRecord.durationMs ?? null,
    failureReason: sessionRecord.failureReason ?? null,
    failureCategory: sessionRecord.failureCategory ?? null,
    failureDiagnostics: Array.isArray(sessionRecord.failureDiagnostics)
      ? sessionRecord.failureDiagnostics.map((diagnostic) => ({ ...diagnostic }))
      : [],
    sourceLanguageCode: sessionRecord.sourceLanguageCode ?? null,
    selectedInputDeviceId: sessionRecord.selectedInputDeviceId ?? null,
    inputDeviceLabelSnapshot: sessionRecord.inputDeviceLabelSnapshot ?? null,
    audioArtifacts: sanitizeAudioArtifactsForDTO(sessionRecord.audioArtifacts, { sessionId: sessionRecord.id }),
    transcriptSummary: copyTranscriptSummary(sessionRecord.transcriptSummary),
    recordKind: sessionRecord.recordKind ?? 'session',
    retranslatedFrom: copyRetranslationProvenance(sessionRecord.retranslatedFrom)
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

function buildReadingContent({
  sessionRecord,
  sourceTranscript,
  selectedTranslationOutput,
  sourceItems,
  translationItems
}) {
  return {
    translationArticle: buildTranslationArticleContent(sessionRecord, selectedTranslationOutput, translationItems),
    sourceTranscript: buildSourceTranscriptContent(sessionRecord, sourceTranscript, sourceItems)
  };
}

function buildTranslationArticleContent(sessionRecord, selectedTranslationOutput, translationItems) {
  const paragraphs = buildTranscriptArticleParagraphs(translationItems);
  const completedAt = selectedTranslationOutput?.completedAt ?? sessionRecord.endedAt ?? null;

  return {
    kind: 'translationArticle',
    status: paragraphs.length > 0 ? 'available' : contentStatusForSession(sessionRecord),
    targetLanguageCode: selectedTranslationOutput?.targetLanguageCode ?? sessionRecord.targetLanguageCode ?? null,
    targetLanguageLabel: selectedTranslationOutput?.targetLanguageLabel ?? sessionRecord.targetLanguageLabel ?? null,
    version: selectedTranslationOutput?.version ?? null,
    text: paragraphs.join('\n\n'),
    paragraphs,
    createdAt: selectedTranslationOutput?.createdAt ?? sessionRecord.startedAt ?? null,
    completedAt,
    emptyReason: paragraphs.length > 0 ? null : emptyReasonForSession(sessionRecord)
  };
}

function buildSourceTranscriptContent(sessionRecord, sourceTranscript, sourceItems) {
  const paragraphs = buildTranscriptArticleParagraphs(sourceItems);

  return {
    kind: 'sourceTranscript',
    status: paragraphs.length > 0 ? 'available' : contentStatusForSession(sessionRecord),
    text: formatTranscriptArticleText(sourceItems),
    paragraphs,
    createdAt: sourceTranscript.createdAt ?? sessionRecord.startedAt ?? null,
    finalizedAt: sourceTranscript.finalizedAt ?? sessionRecord.endedAt ?? null,
    emptyReason: paragraphs.length > 0 ? null : emptyReasonForSession(sessionRecord)
  };
}

function contentStatusForSession(sessionRecord) {
  if (!TERMINAL_SESSION_STATUSES.has(sessionRecord?.status)) {
    return 'processing';
  }

  if (sessionRecord?.status === 'failed') {
    return 'failed';
  }

  return 'empty';
}

function emptyReasonForSession(sessionRecord) {
  if (!TERMINAL_SESSION_STATUSES.has(sessionRecord?.status)) {
    return 'processing';
  }

  if (sessionRecord?.status === 'failed') {
    return 'finalize_failed';
  }

  return 'no_content';
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

function copyRetranslationProvenance(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return {
    sessionId: value.sessionId ?? null,
    startedAt: value.startedAt ?? null,
    requestId: value.requestId ?? null,
    executionId: value.executionId ?? null,
    outputId: value.outputId ?? null
  };
}
