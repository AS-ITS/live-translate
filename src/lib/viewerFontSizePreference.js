export const VIEWER_FONT_SIZE_STORAGE_KEY = 'live-translate:viewer-font-size:v1';
export const DEFAULT_VIEWER_FONT_SIZE = 'medium';
export const VIEWER_FONT_SIZES = Object.freeze(['small', 'medium', 'large']);

export function normalizeViewerFontSize(value) {
  return VIEWER_FONT_SIZES.includes(value) ? value : DEFAULT_VIEWER_FONT_SIZE;
}

export function readViewerFontSizePreference(storage = globalThis.localStorage) {
  if (!storage) return DEFAULT_VIEWER_FONT_SIZE;
  try {
    return normalizeViewerFontSize(storage.getItem(VIEWER_FONT_SIZE_STORAGE_KEY));
  } catch {
    return DEFAULT_VIEWER_FONT_SIZE;
  }
}

export function writeViewerFontSizePreference(value, storage = globalThis.localStorage) {
  const normalized = normalizeViewerFontSize(value);
  try {
    storage?.setItem(VIEWER_FONT_SIZE_STORAGE_KEY, normalized);
  } catch {
    // Browser privacy settings or quota errors must not block the display control.
  }
  return normalized;
}
