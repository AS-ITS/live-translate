export const VIEWER_LATEST_THRESHOLD_PX = 24;

export function isViewerAtLatestPosition(viewport, threshold = VIEWER_LATEST_THRESHOLD_PX) {
  if (!viewport) return true;
  return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= threshold;
}

export function resolveViewerAutoFollow({ following, userInitiated, viewport }) {
  if (isViewerAtLatestPosition(viewport)) return true;
  if (userInitiated) return false;
  return following;
}

export function scrollViewerToLatest(viewport) {
  if (!viewport) return;
  viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'auto' });
}

export function captureViewerScrollAnchor({ cues = [], offsets = [], scrollTop = 0 } = {}) {
  if (cues.length === 0 || offsets.length === 0) return null;
  let low = 0;
  let high = Math.min(cues.length, offsets.length);
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (offsets[middle] <= scrollTop) low = middle + 1;
    else high = middle;
  }
  const index = Math.max(0, low - 1);
  const cueId = cues[index]?.cueId;
  if (!cueId) return null;
  return { cueId, offset: Math.max(0, scrollTop - offsets[index]) };
}

export function restoreViewerScrollAnchor(viewport, anchor, cues = [], offsets = []) {
  if (!viewport || !anchor?.cueId) return false;
  const index = cues.findIndex((cue) => cue?.cueId === anchor.cueId);
  if (index < 0 || !Number.isFinite(offsets[index])) return false;
  viewport.scrollTo({ top: offsets[index] + anchor.offset, behavior: 'auto' });
  return true;
}

export function countUnseenViewerCues(cues = [], seenCueIds = new Set()) {
  return new Set(cues.map((cue) => cue?.cueId).filter((cueId) => cueId && !seenCueIds.has(cueId))).size;
}
