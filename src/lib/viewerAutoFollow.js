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
