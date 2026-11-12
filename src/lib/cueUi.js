export const CUE_FOLLOW_BOTTOM_THRESHOLD_PX = 80;
import { effectiveSourceForCue, effectiveTranslationForCue } from './cueContent.js';
import { projectAdjacentFinalCues } from './adjacentCueProjection.js';
import { toTraditionalChineseText } from './chineseText.js';

export function formatCueTimecode(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '--:--.---';
  const totalMs = Math.floor(milliseconds);
  const ms = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  const pad = (value, length) => String(value).padStart(length, '0');
  return hours > 0
    ? `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(ms, 3)}`
    : `${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(ms, 3)}`;
}

export function sortFinalCues(cues = []) {
  return cues.filter((cue) => cue?.status === 'final').slice()
    .sort((left, right) => (left.sequence || 0) - (right.sequence || 0));
}

export function sourceTextForCopy(cues = []) {
  return projectAdjacentFinalCues(sortFinalCues(cues), { stream: 'source' })
    .map((cue) => sourceTextForDisplay(cue))
    .filter(Boolean)
    .join('\n');
}

export function translationTextForCopy(cues = []) {
  return projectAdjacentFinalCues(sortFinalCues(cues), { stream: 'translation' })
    .map((cue) => effectiveTranslationForCue(cue))
    .filter(Boolean)
    .join('\n');
}

export function upsertFinalCue(cues = [], cue) {
  if (!cue?.cueId || cue.status !== 'final') return sortFinalCues(cues);
  const next = [...cues];
  const index = next.findIndex((item) => item?.cueId === cue.cueId);
  if (index >= 0) next[index] = { ...next[index], ...cue };
  else next.push(cue);
  return sortFinalCues(next);
}

export function partialCueForDisplay(state = {}, { requireSourceText = false } = {}) {
  const candidates = [state.currentCue, ...(state.pendingCues || [])]
    .filter((cue) => cue && cue.status !== 'final')
    .filter((cue) => hasMeaningfulPartialText(cue.sourceText) || hasMeaningfulPartialText(cue.translatedText))
    .filter((cue) => !requireSourceText || hasMeaningfulPartialText(cue.sourceText))
    .sort((left, right) => (right.updatedTimeMs || right.endTimeMs || 0) - (left.updatedTimeMs || left.endTimeMs || 0));
  if (candidates.length === 0) return null;
  return candidates.reduce((merged, cue) => ({
    ...merged,
    cueId: merged.cueId || cue.cueId,
    sessionId: merged.sessionId || cue.sessionId,
    segmentId: merged.segmentId || cue.segmentId,
    sequence: Math.min(merged.sequence || cue.sequence, cue.sequence || merged.sequence),
    startTimeMs: Math.min(merged.startTimeMs ?? cue.startTimeMs, cue.startTimeMs ?? merged.startTimeMs),
    endTimeMs: Math.max(merged.endTimeMs ?? cue.endTimeMs, cue.endTimeMs ?? merged.endTimeMs),
    sourceText: merged.sourceText || cue.sourceText || '',
    translatedText: merged.translatedText || cue.translatedText || '',
    status: 'partial'
  }), {});
}

function hasMeaningfulPartialText(text) {
  const normalized = String(text || '').trim();
  return Boolean(normalized) && !/^[\s\p{P}\p{S}]+$/u.test(normalized);
}

export function cueListForDisplay(state = {}, {
  includePartial = true,
  requireSourceTextForPartial = false,
  mergeRepeatedFinalCues = false
} = {}) {
  const final = sortFinalCues(mergeRefinedCuesWithRaw(state.finalCues, state.refinedSubtitleCues));
  const partial = includePartial ? partialCueForDisplay(state, { requireSourceText: requireSourceTextForPartial }) : null;
 const projectedFinal = projectAdjacentFinalCues(final);
 const displayedFinal = mergeRepeatedFinalCues ? mergeAdjacentFinalCues(projectedFinal) : projectedFinal;
  const cues = partial ? [...displayedFinal, partial] : displayedFinal;
  return cues.map((cue) => ({
    ...cue,
    sourceText: sourceTextForDisplay(cue)
  }));
}

export function sourceTextForDisplay(cue, variant = 'raw') {
  const text = effectiveSourceForCue(cue, variant);
  return cue?.sourceLanguageCode === 'zh-Hans' ? text : toTraditionalChineseText(text);
}

function mergeRefinedCuesWithRaw(rawCues = [], refinedCues = []) {
  const raw = Array.isArray(rawCues) ? rawCues : [];
  const refined = Array.isArray(refinedCues) ? refinedCues : [];
  if (refined.length === 0) return raw;

  const refinedById = new Map(refined.map((cue) => [cue?.cueId, cue]));
  const merged = raw.map((cue) => refinedById.has(cue?.cueId)
    ? { ...cue, ...refinedById.get(cue.cueId) }
    : cue);
  const rawIds = new Set(raw.map((cue) => cue?.cueId));
  return merged.concat(refined.filter((cue) => cue?.cueId && !rawIds.has(cue.cueId)));
}

function mergeAdjacentFinalCues(cues) {
  const merged = [];

  for (const cue of cues) {
    const previous = merged.at(-1);
    if (!previous || !areIdenticalAdjacentFinalCues(previous, cue)) {
      merged.push(cue);
      continue;
    }

    merged[merged.length - 1] = {
      ...previous,
      endTimeMs: Math.max(previous.endTimeMs || 0, cue.endTimeMs || 0),
      updatedTimeMs: Math.max(previous.updatedTimeMs || 0, cue.updatedTimeMs || 0),
      ...(cue.finalizedReason ? { finalizedReason: cue.finalizedReason } : {})
    };
  }

  return merged;
}

function areIdenticalAdjacentFinalCues(previous, next) {
  return previous.status === 'final' &&
    next.status === 'final' &&
    previous.sessionId === next.sessionId &&
    previous.segmentId === next.segmentId &&
    effectiveSourceForCue(previous) === effectiveSourceForCue(next) &&
    effectiveTranslationForCue(previous) === effectiveTranslationForCue(next);
}

export function distanceFromScrollBottom(element) {
  if (!element) return 0;
  return Math.max(0, element.scrollHeight - element.scrollTop - element.clientHeight);
}

export function shouldFollowLatest(element, threshold = CUE_FOLLOW_BOTTOM_THRESHOLD_PX) {
  return distanceFromScrollBottom(element) <= threshold;
}
