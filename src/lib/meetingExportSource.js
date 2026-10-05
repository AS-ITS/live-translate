import { createHash } from 'node:crypto';

export function meetingExportSource(detail = {}) {
  const items = Array.isArray(detail.transcriptItems)
    ? detail.transcriptItems.filter((item) => item && typeof item.text === 'string' && item.text.trim())
    : [];
  const cues = Array.isArray(detail.cues)
    ? detail.cues.filter((cue) => cue?.status === 'final')
    : [];
  const sortedItems = [...items].sort(compareTranscriptItems);
  const sortedCues = [...cues].sort(compareCues);
  const timeOrigin = finiteTimestamp(detail.meeting?.startedAt)
    ?? finiteTimestamp(sortedItems[0]?.startedAt)
    ?? 0;
  const canonical = {
    cues: sortedCues.map((cue) => ({
      cueId: cue.cueId,
      sessionId: cue.sessionId ?? null,
      segmentId: cue.segmentId ?? null,
      segmentSequence: cue.segmentSequence ?? null,
      sequence: cue.sequence ?? null,
      status: cue.status,
      sourceText: cue.rawSource ?? cue.sourceText ?? '',
      translatedText: cue.translatedText ?? '',
      sourceVersion: cue.sourceVersion ?? 1,
      translationVersion: cue.translationVersion ?? 0,
      startTimeMs: cue.startTimeMs ?? null,
      endTimeMs: cue.endTimeMs ?? null,
      sourceLanguageCode: cue.sourceLanguageCode ?? null,
      targetLanguageCode: cue.targetLanguageCode ?? null
    })),
    items: sortedItems.map((item) => ({
      id: item.id ?? null,
      segmentId: item.segmentId ?? null,
      segmentSequence: item.segmentSequence ?? null,
      stream: item.stream ?? null,
      sequence: item.sequence ?? null,
      text: item.text,
      startedAt: item.startedAt ?? null,
      finalizedAt: item.finalizedAt ?? null
    }))
  };

  return Object.freeze({
    items: sortedItems,
    cues: sortedCues,
    timeOrigin,
    sourceHash: createHash('sha256').update(JSON.stringify(canonical)).digest('hex'),
    canonical
  });
}

function compareTranscriptItems(left, right) {
  return numberOrMax(left.segmentSequence) - numberOrMax(right.segmentSequence)
    || numberOrMax(left.sequence) - numberOrMax(right.sequence)
    || numberOrMax(left.startedAt) - numberOrMax(right.startedAt)
    || String(left.id ?? '').localeCompare(String(right.id ?? ''));
}

function compareCues(left, right) {
  return numberOrMax(left.segmentSequence) - numberOrMax(right.segmentSequence)
    || numberOrMax(left.startTimeMs) - numberOrMax(right.startTimeMs)
    || numberOrMax(left.sequence) - numberOrMax(right.sequence)
    || String(left.cueId ?? '').localeCompare(String(right.cueId ?? ''));
}

function numberOrMax(value) {
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

function finiteTimestamp(value) {
  if (Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
