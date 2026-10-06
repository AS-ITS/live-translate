import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SUBTITLE_VISIBILITY,
  normalizeSubtitleVisibilityPreference,
  readSubtitleVisibilityPreference,
  toggleSubtitleVisibility,
  writeSubtitleVisibilityPreference
} from '../../src/lib/subtitleVisibilityPreference.js';

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, value); }
  };
}

test('subtitle visibility defaults both streams to visible', () => {
  assert.deepEqual(readSubtitleVisibilityPreference('missing', memoryStorage()), DEFAULT_SUBTITLE_VISIBILITY);
  assert.deepEqual(normalizeSubtitleVisibilityPreference({ showSource: false }), {
    showSource: false,
    showTranslation: true
  });
});

test('subtitle visibility repairs a stored both-hidden preference', () => {
  const storage = memoryStorage({ display: JSON.stringify({ showSource: false, showTranslation: false }) });
  assert.deepEqual(readSubtitleVisibilityPreference('display', storage), DEFAULT_SUBTITLE_VISIBILITY);
  assert.deepEqual(JSON.parse(storage.getItem('display')), DEFAULT_SUBTITLE_VISIBILITY);
});

test('subtitle visibility supports all valid combinations and refuses both hidden', () => {
  const both = { showSource: true, showTranslation: true };
  const sourceOnly = toggleSubtitleVisibility(both, 'translation');
  const translationOnly = toggleSubtitleVisibility(both, 'source');

  assert.deepEqual(sourceOnly, { showSource: true, showTranslation: false });
  assert.deepEqual(translationOnly, { showSource: false, showTranslation: true });
  assert.deepEqual(toggleSubtitleVisibility(sourceOnly, 'source'), sourceOnly);
  assert.deepEqual(toggleSubtitleVisibility(translationOnly, 'translation'), translationOnly);
});

test('subtitle visibility persists normalized values', () => {
  const storage = memoryStorage();
  assert.deepEqual(
    writeSubtitleVisibilityPreference('display', { showSource: true, showTranslation: false }, storage),
    { showSource: true, showTranslation: false }
  );
  assert.deepEqual(readSubtitleVisibilityPreference('display', storage), {
    showSource: true,
    showTranslation: false
  });
});
