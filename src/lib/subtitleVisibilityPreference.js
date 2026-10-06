export const RECORDER_SUBTITLE_VISIBILITY_STORAGE_KEY = 'live-translate:subtitle-visibility:recorder:v1';
export const VIEWER_SUBTITLE_VISIBILITY_STORAGE_KEY = 'live-translate:subtitle-visibility:viewer:v1';

export const DEFAULT_SUBTITLE_VISIBILITY = Object.freeze({
  showSource: true,
  showTranslation: true
});

export function normalizeSubtitleVisibilityPreference(value) {
  const preference = {
    showSource: value?.showSource !== false,
    showTranslation: value?.showTranslation !== false
  };

  return preference.showSource || preference.showTranslation
    ? preference
    : { ...DEFAULT_SUBTITLE_VISIBILITY };
}

export function readSubtitleVisibilityPreference(storageKey, storage = globalThis.localStorage) {
  if (!storage) return { ...DEFAULT_SUBTITLE_VISIBILITY };

  try {
    const stored = storage.getItem(storageKey);
    if (stored === null) return { ...DEFAULT_SUBTITLE_VISIBILITY };

    const parsed = JSON.parse(stored);
    const normalized = normalizeSubtitleVisibilityPreference(parsed);
    if (parsed?.showSource === false && parsed?.showTranslation === false) {
      storage.setItem(storageKey, JSON.stringify(normalized));
    }
    return normalized;
  } catch {
    return { ...DEFAULT_SUBTITLE_VISIBILITY };
  }
}

export function writeSubtitleVisibilityPreference(storageKey, value, storage = globalThis.localStorage) {
  const normalized = normalizeSubtitleVisibilityPreference(value);
  try {
    storage?.setItem(storageKey, JSON.stringify(normalized));
  } catch {
    // Browser privacy settings or quota errors must not block subtitle controls.
  }
  return normalized;
}

export function toggleSubtitleVisibility(preference, stream) {
  const current = normalizeSubtitleVisibilityPreference(preference);
  if (stream === 'source') {
    if (current.showSource && !current.showTranslation) return current;
    return { ...current, showSource: !current.showSource };
  }
  if (stream === 'translation') {
    if (current.showTranslation && !current.showSource) return current;
    return { ...current, showTranslation: !current.showTranslation };
  }
  return current;
}
