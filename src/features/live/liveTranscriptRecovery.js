import { completedCueRefinementOutputs } from '../../lib/cueRefinement.js';
import { createTranscriptState, formatTranscriptArticleText } from '../../lib/transcript.js';
import { toTraditionalChineseText } from '../../lib/chineseText.js';

const TRANSCRIPT_SEGMENT_LOG_ENABLED = Boolean(import.meta.env?.DEV);
const RECONNECT_FAILED_MESSAGE = '無法重新連線即時字幕。準備就緒後可以開始新的工作階段。';
const RECONNECT_EXHAUSTED_MESSAGE = '即時字幕多次重新連線後仍未成功。準備就緒後可以開始新的工作階段。';

export function logTranscriptSegmentDecision(update, decision, previous, next) {
  if (!TRANSCRIPT_SEGMENT_LOG_ENABLED) {
    return;
  }

  const streamState = next?.[update.stream] || previous?.[update.stream];
  console.debug('[Transcript segmenter]', {
    stream: update.stream,
    inputText: update.stream === 'source' ? update.text : '',
    outputText: update.stream === 'translation' ? update.text : '',
    turnFinal: Boolean(update.isFinal),
    decision,
    completedSegments: streamState?.finalItems?.map((item) => item.text) || [],
    pendingText: streamState?.currentPartial?.text || ''
  });
}

export function transcriptStateFromCheckpointChunks(chunks = []) {
  const state = createTranscriptState();
  const transcriptItems = chunks
    .filter((chunk) => (
      chunk &&
      (chunk.stream === 'source' || chunk.stream === 'translation') &&
      Number.isInteger(chunk.sequence) &&
      typeof chunk.text === 'string' &&
      chunk.text.trim().length > 0
    ))
    .map((chunk) => ({
      id: chunk.idempotencyKey || `checkpoint:${chunk.segmentId}:${chunk.stream}:${chunk.sequence}`,
      stream: chunk.stream,
      status: 'final',
      text: chunk.text,
      sequence: chunk.sequence,
      startedAt: chunk.timestamp,
      finalizedAt: chunk.timestamp,
      ...(chunk.sessionId ? { sessionId: chunk.sessionId } : {}),
      ...(chunk.segmentId ? { segmentId: chunk.segmentId } : {}),
      ...(chunk.sourceLanguageCode ? { sourceLanguageCode: chunk.sourceLanguageCode } : {}),
      ...(chunk.targetLanguageCode ? { targetLanguageCode: chunk.targetLanguageCode } : {})
    }))
    .sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));

  const maxSequence = transcriptItems.reduce((max, item) => Math.max(max, item.sequence), 0);

  return {
    ...state,
    source: {
      ...state.source,
      finalItems: transcriptItems.filter((item) => item.stream === 'source')
    },
    translation: {
      ...state.translation,
      finalItems: transcriptItems.filter((item) => item.stream === 'translation')
    },
    nextSequence: maxSequence + 1
  };
}

export function transcriptSegmentsFromCheckpoints({ segments = [], checkpoints = [] } = {}) {
  return segments
    .map((segment, index) => ({
      id: segment.id,
      sequence: segment.sequence,
      transcript: transcriptStateFromCheckpointChunks(checkpoints[index]?.checkpoint?.durableChunks || [])
    }))
    .filter((segment) => transcriptHasFinalItems(segment.transcript) > 0)
    .sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
}

export function unrepresentedTranscriptItems({ archivedTranscript, transcript, cues = [] } = {}) {
  const items = [
    ...(archivedTranscript?.source?.finalItems || []),
    ...(archivedTranscript?.translation?.finalItems || []),
    ...(transcript?.source?.finalItems || []),
    ...(transcript?.translation?.finalItems || [])
  ];
  const seenIds = new Set();
  return items
    .filter((item) => item?.status === 'final' && typeof item.text === 'string' && item.text.trim())
    .filter((item) => {
      if (item.id && seenIds.has(item.id)) return false;
      if (item.id) seenIds.add(item.id);
      return !cues.some((cue) => transcriptItemCoveredByCue(item, cue));
    })
    .sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
}
export function transcriptItemCoveredByCue(item, cue) {
  if (!cue || !['final', 'partial'].includes(cue.status) || (cue.stream && cue.stream !== item.stream)) return false;
  if (!matchingTranscriptScope(item, cue)) return false;
  if (item.audioTurnId && cue.audioTurnId) return item.audioTurnId === cue.audioTurnId;
  const cueText = item.stream === 'source' ? cue.sourceText : cue.translatedText;
  const itemText = normalizeFallbackText(item.text);
  const normalizedCueText = normalizeFallbackText(cueText);
  return Boolean(itemText && normalizedCueText && (
    normalizedCueText.includes(itemText) || itemText.includes(normalizedCueText)
  ));
}

function matchingTranscriptScope(item, cue) {
  return ['sessionId', 'liveSessionId', 'segmentId'].every((field) => (
    !item?.[field] || !cue?.[field] || item[field] === cue[field]
  ));
}

export function normalizeFallbackText(value) {
  return String(value || '').replace(/\s+/gu, '').trim();
}

export function archivedTranscriptFromSegments(segments = [], fallbackNextSequence = 1) {
  const transcripts = segments.map((segment) => segment.transcript);
  const archivedSource = mergeTranscriptItems(transcripts.flatMap((transcript) => transcript?.source?.finalItems || []));
  const archivedTranslation = mergeTranscriptItems(transcripts.flatMap((transcript) => transcript?.translation?.finalItems || []));
  const nextSequence = Math.max(
    fallbackNextSequence,
    ...transcripts.map((transcript) => transcript?.nextSequence || 1)
  );

  return {
    source: { finalItems: archivedSource, currentPartial: null },
    translation: { finalItems: archivedTranslation, currentPartial: null },
    nextSequence
  };
}

export function mergeTranscriptItems(items = []) {
  const byId = new Map();
  for (const item of items) {
    if (item?.status === 'final' && typeof item.id === 'string') {
      byId.set(item.id, item);
    }
  }
  return Array.from(byId.values()).sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
}

export function emptyTranscriptStateWithNextSequence(nextSequence) {
  return {
    ...createTranscriptState(),
    nextSequence: Number.isFinite(nextSequence) && nextSequence > 0 ? nextSequence : 1
  };
}

export function transcriptHasFinalItems(transcriptState) {
  return (transcriptState?.source?.finalItems?.length || 0) + (transcriptState?.translation?.finalItems?.length || 0);
}

export function activeSegmentTranscriptCount(transcriptState) {
  return transcriptHasFinalItems(transcriptState) +
    (transcriptState?.source?.currentPartial ? 1 : 0) +
    (transcriptState?.translation?.currentPartial ? 1 : 0);
}

export function reconnectErrorMessage(result, diagnostic = null) {
  const detail = diagnostic ? `（來源：${diagnostic.source}；原因：${diagnostic.reason}${diagnostic.code ? `；代碼：${diagnostic.code}` : ''}${diagnostic.status ? `；狀態：${diagnostic.status}` : ''}）` : '';
  if (result?.decision?.stopReason === 'max_attempts_exceeded') {
    return `${RECONNECT_EXHAUSTED_MESSAGE}${detail}`;
  }

  return `${RECONNECT_FAILED_MESSAGE}${detail}`;
}

export function safeReconnectDiagnostic(failure = {}, classification = {}) {
  const sourceDiagnostic = failure.diagnostic || {};
  return {
    at: sourceDiagnostic.at || new Date().toISOString(),
    source: failure.source || 'unknown',
    stage: failure.stage || sourceDiagnostic.stage || null,
    reason: classification.reason || failure.reasonHint || 'unknown_error',
    category: classification.category || null,
    code: safeDiagnosticValue(sourceDiagnostic.code || failure.rawEvent?.code),
    status: safeDiagnosticStatus(sourceDiagnostic.status || failure.rawError?.status || failure.rawError?.response?.status),
    connectionEpoch: sourceDiagnostic.connectionEpoch ?? null,
    liveSessionId: sourceDiagnostic.liveSessionId || null,
    segmentId: sourceDiagnostic.segmentId || null,
    audioCallbackCount: sourceDiagnostic.audioCallbackCount ?? null,
    pcmSendAttemptCount: sourceDiagnostic.pcmSendAttemptCount ?? null,
    pcmSendSyncThrowCount: sourceDiagnostic.pcmSendSyncThrowCount ?? null,
    pcmSendAsyncRejectCount: sourceDiagnostic.pcmSendAsyncRejectCount ?? null
  };
}

export function safeDiagnosticValue(value) {
  return typeof value === 'string' || typeof value === 'number' ? value : null;
}

export function safeDiagnosticStatus(value) {
  return Number.isInteger(value) ? value : null;
}

export function articleTextForItems(items, stream) {
  const articleText = formatTranscriptArticleText(items || []);
  return stream === 'source' ? toTraditionalChineseText(articleText) : articleText;
}

export function traditionalChineseTranscriptItem(item) {
  if (!item) {
    return item;
  }

  return {
    ...item,
    text: toTraditionalChineseText(item.text)
  };
}

export function transcriptTextForDisplay(item) {
  if (!item || item.stream !== 'source') return item?.text || '';
  return item.sourceLanguageCode === 'zh-Hans' ? item.text : toTraditionalChineseText(item.text);
}

export function buildArticleFileName(stream) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `live-translate-article-${stream}-${stamp}.txt`;
}

export function latestPolishingOutput(detail) {
  return completedPolishingOutputs(detail)
    .sort((left, right) => (right.version || 0) - (left.version || 0) || String(right.completedAt || '').localeCompare(String(left.completedAt || '')))[0] || null;
}

export function completedPolishingOutputs(detail) {
  return completedCueRefinementOutputs(detail);
}

export function rawCuesFromDetail(cues = []) {
  return (Array.isArray(cues) ? cues : [])
    .filter((cue) => !cue?.cueId?.startsWith('refined-subtitle:'));
}

export function latestPolishingExecution(detail) {
  return (detail?.translationHistory?.executions || [])
    .filter((execution) => execution.operation === 'transcript_polishing')
    .sort((left, right) => (
      timestampMs(right.startedAt || right.completedAt || right.createdAt) - timestampMs(left.startedAt || left.completedAt || left.createdAt)
      || String(right.id || '').localeCompare(String(left.id || ''))
    ))[0] || null;
}

function timestampMs(value) {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? timestamp : 0;
}
