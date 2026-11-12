import { effectiveSourceForCue, effectiveTranslationForCue } from './cueContent.js';

import { mergeFinalCue } from '../domain/subtitleCue/index.js';

export function mergeMeetingDetailWithLocalCues(detail, localRecords = [], { authoritative = false } = {}) {
  if (!detail || typeof detail !== 'object') return detail;

  const cloudCues = finalCues(detail.cues);
  const localCues = finalCues((Array.isArray(localRecords) ? localRecords : []).map(localCueFromRecord));
  if (localCues.length === 0 && !authoritative) return detail;
  const cues = authoritative ? localCues : reconcileDurableCues(cloudCues, localCues);
  const sourceParagraphs = cueParagraphs(cues, 'source');
  const translationParagraphs = cueParagraphs(cues, 'translation');
  const totalItems = sourceParagraphs.length + translationParagraphs.length;
  const startedAt = detail.meeting?.startedAt ?? null;
  const endedAt = detail.meeting?.endedAt ?? null;
  const targetLanguageCode = detail.meeting?.targetLanguageCode ?? null;
  const cloudSnapshot = JSON.stringify(cloudCues.map(canonicalCueContent));
  const mergedSnapshot = JSON.stringify(cues.map(canonicalCueContent));

  return {
    ...detail,
    meeting: {
      ...(detail.meeting || {}),
      transcriptSummary: {
        totalItems,
        sourceFinalCount: sourceParagraphs.length,
        translationFinalCount: translationParagraphs.length,
        hasTranscript: totalItems > 0
      }
    },
    cues,
    transcriptItems: transcriptItemsFromCues(cues, detail.meeting?.id),
    readingContent: {
      sourceTranscript: {
        kind: 'sourceTranscript',
        status: sourceParagraphs.length > 0 ? 'available' : 'empty',
        text: sourceParagraphs.join('\n\n'),
        paragraphs: sourceParagraphs,
        createdAt: startedAt,
        finalizedAt: endedAt,
        emptyReason: sourceParagraphs.length > 0 ? null : 'no_content'
      },
      translationArticle: {
        kind: 'translationArticle',
        status: translationParagraphs.length > 0 ? 'available' : 'empty',
        text: translationParagraphs.join('\n\n'),
        paragraphs: translationParagraphs,
        targetLanguageCode,
        targetLanguageLabel: detail.readingContent?.translationArticle?.targetLanguageLabel ?? null,
        version: detail.readingContent?.translationArticle?.version ?? null,
        createdAt: startedAt,
        completedAt: endedAt,
        emptyReason: translationParagraphs.length > 0 ? null : 'no_content'
      }
    },
    localTranscriptStatus: cloudSnapshot === mergedSnapshot ? 'synced' : 'recovered'
  };
}

// Local records own versioned Final Cues. Historical unversioned snapshots keep
// their existing read projection until they can be compared by revision.
export function reconcileDurableCues(checkpointCues = [], localCues = []) {
  const byId = new Map(finalCues(checkpointCues).map((cue) => [cue.cueId, cue]));
  for (const local of finalCues(localCues)) {
    const checkpoint = byId.get(local.cueId);
    if (!checkpoint) {
      byId.set(local.cueId, local);
      continue;
    }
    if (Number.isSafeInteger(checkpoint.revision) && Number.isSafeInteger(local.revision)) {
      const result = mergeFinalCue([checkpoint], local);
      if (result.cue.revision !== local.revision) {
        const error = new Error('Checkpoint Cue is ahead of the Local Cue Store.');
        error.code = 'local_cue_checkpoint_ahead';
        throw error;
      }
      byId.set(local.cueId, local);
    } else {
      byId.set(local.cueId, mergeFinalCues([checkpoint], [local])[0]);
    }
  }
  return [...byId.values()].sort(compareCues);
}

export function mergeFinalCues(existingCues = [], incomingCues = []) {
  const byId = new Map();
  for (const cue of [...finalCues(existingCues), ...finalCues(incomingCues)]) {
    const existing = byId.get(cue.cueId);
    byId.set(cue.cueId, existing ? mergeCueUpdate(existing, cue) : { ...cue });
  }
  return [...byId.values()].sort(compareCues);
}

function localCueFromRecord(record) {
  if (!record || typeof record !== 'object') return null;
  const raw = record.cue && typeof record.cue === 'object' ? record.cue : record;
  return {
    ...raw,
    cueId: raw.cueId || record.cueId,
    sessionId: raw.sessionId || record.sessionId,
    segmentId: raw.segmentId || record.segmentId,
    sequence: raw.sequence ?? record.sequence
  };
}

function finalCues(cues) {
  return (Array.isArray(cues) ? cues : []).filter((cue) => (
    cue?.status === 'final'
    && typeof cue.cueId === 'string'
    && cue.cueId.trim() !== ''
    && (meaningfulText(effectiveSourceForCue(cue)) || meaningfulText(effectiveTranslationForCue(cue)))
  ));
}

function mergeCueUpdate(existing, incoming) {
  const source = selectSide(existing, incoming, 'source');
  const translation = selectSide(existing, incoming, 'translation');
  return {
    ...existing,
    ...incoming,
    startTimeMs: minFinite(existing.startTimeMs, incoming.startTimeMs),
    endTimeMs: maxFinite(existing.endTimeMs, incoming.endTimeMs),
    sourceText: source.text,
    sourceVersion: source.version,
    translatedText: translation.text,
    translationVersion: translation.version,
    refinedSource: meaningfulText(incoming.refinedSource) ? incoming.refinedSource : existing.refinedSource,
    refinedTranslation: meaningfulText(incoming.refinedTranslation) ? incoming.refinedTranslation : existing.refinedTranslation
  };
}

function selectSide(existing, incoming, side) {
  const textKey = side === 'source' ? 'sourceText' : 'translatedText';
  const rawKey = side === 'source' ? 'rawSource' : 'rawTranslation';
  const versionKey = side === 'source' ? 'sourceVersion' : 'translationVersion';
  const existingText = meaningfulText(existing[textKey]) ? existing[textKey] : existing[rawKey] || '';
  const incomingText = meaningfulText(incoming[textKey]) ? incoming[textKey] : incoming[rawKey] || '';
  const existingVersion = finiteVersion(existing[versionKey]);
  const incomingVersion = finiteVersion(incoming[versionKey]);

  if (!meaningfulText(incomingText)) return { text: existingText, version: existingVersion };
  if (!meaningfulText(existingText) || incomingVersion >= existingVersion) {
    return { text: incomingText, version: incomingVersion };
  }
  return { text: existingText, version: existingVersion };
}

function cueParagraphs(cues, stream) {
  return cues
    .map((cue) => stream === 'source' ? effectiveSourceForCue(cue) : effectiveTranslationForCue(cue))
    .map((text) => typeof text === 'string' ? text.trim() : '')
    .filter(meaningfulText);
}

function transcriptItemsFromCues(cues, meetingId) {
  return cues.flatMap((cue) => [
    meaningfulText(effectiveSourceForCue(cue)) ? transcriptItem(cue, meetingId, 'source', effectiveSourceForCue(cue)) : null,
    meaningfulText(effectiveTranslationForCue(cue)) ? transcriptItem(cue, meetingId, 'translation', effectiveTranslationForCue(cue)) : null
  ].filter(Boolean));
}

function transcriptItem(cue, meetingId, stream, text) {
  return {
    id: `local:${cue.segmentId}:${cue.cueId}:${stream}`,
    meetingId: meetingId || null,
    segmentId: cue.segmentId,
    liveSessionId: cue.sessionId,
    stream,
    status: 'final',
    text: text.trim(),
    sequence: cue.sequence,
    startedAt: cue.startTimeMs,
    finalizedAt: cue.finalizedAt ?? cue.endTimeMs
  };
}

function canonicalCueContent(cue) {
  return [cue.cueId, effectiveSourceForCue(cue), effectiveTranslationForCue(cue)];
}

function compareCues(left, right) {
  return (Number(left.sequence) || 0) - (Number(right.sequence) || 0)
    || (Number(left.startTimeMs) || 0) - (Number(right.startTimeMs) || 0)
    || left.cueId.localeCompare(right.cueId);
}

function meaningfulText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function finiteVersion(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function minFinite(left, right) {
  const values = [left, right].filter(Number.isFinite);
  return values.length > 0 ? Math.min(...values) : null;
}

function maxFinite(left, right) {
  const values = [left, right].filter(Number.isFinite);
  return values.length > 0 ? Math.max(...values) : null;
}
