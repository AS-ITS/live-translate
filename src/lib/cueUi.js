export const CUE_FOLLOW_BOTTOM_THRESHOLD_PX = 80;

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

export function upsertFinalCue(cues = [], cue) {
  if (!cue?.cueId || cue.status !== 'final') return sortFinalCues(cues);
  const next = [...cues];
  const index = next.findIndex((item) => item?.cueId === cue.cueId);
  if (index >= 0) next[index] = { ...next[index], ...cue };
  else next.push(cue);
  return sortFinalCues(next);
}

export function partialCueForDisplay(state = {}) {
  const candidates = [state.currentCue, ...(state.pendingCues || [])]
    .filter((cue) => cue && cue.status !== 'final')
    .filter((cue) => hasMeaningfulPartialText(cue.sourceText) || hasMeaningfulPartialText(cue.translatedText))
    .sort((left, right) => (right.updatedTimeMs || right.endTimeMs || 0) - (left.updatedTimeMs || left.endTimeMs || 0));
  if (candidates.length === 0) return null;
  return candidates.reduce((merged, cue) => ({
    ...merged,
    cueId: merged.cueId || cue.cueId,
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

export function cueListForDisplay(state = {}, { includePartial = true } = {}) {
  const final = sortFinalCues(state.finalCues);
  const partial = includePartial ? partialCueForDisplay(state) : null;
  return partial ? [...final, partial] : final;
}

export function distanceFromScrollBottom(element) {
  if (!element) return 0;
  return Math.max(0, element.scrollHeight - element.scrollTop - element.clientHeight);
}

export function shouldFollowLatest(element, threshold = CUE_FOLLOW_BOTTOM_THRESHOLD_PX) {
  return distanceFromScrollBottom(element) <= threshold;
}
