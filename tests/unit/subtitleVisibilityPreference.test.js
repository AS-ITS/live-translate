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

test('subtitle visibility switches source only to translation only when source is hidden', () => {
  const both = { showSource: true, showTranslation: true };
  const sourceOnly = toggleSubtitleVisibility(both, 'translation');
  assert.deepEqual(sourceOnly, { showSource: true, showTranslation: false });
  assert.deepEqual(toggleSubtitleVisibility(sourceOnly, 'source'), {
    showSource: false,
    showTranslation: true
  });
});

test('subtitle visibility switches translation only to source only when translation is hidden', () => {
  const translationOnly = { showSource: false, showTranslation: true };
  assert.deepEqual(toggleSubtitleVisibility(translationOnly, 'translation'), {
    showSource: true,
    showTranslation: false
  });
});

test('subtitle visibility hides either stream when both are visible', () => {
  const both = { showSource: true, showTranslation: true };
  assert.deepEqual(toggleSubtitleVisibility(both, 'source'), {
    showSource: false,
    showTranslation: true
  });
  assert.deepEqual(toggleSubtitleVisibility(both, 'translation'), {
    showSource: true,
    showTranslation: false
  });
});

test('subtitle visibility never returns both streams hidden', () => {
  const states = [
    { showSource: true, showTranslation: true },
    { showSource: true, showTranslation: false },
    { showSource: false, showTranslation: true },
    { showSource: false, showTranslation: false }
  ];

  for (const state of states) {
    for (const stream of ['source', 'translation']) {
      const next = toggleSubtitleVisibility(state, stream);
      assert.equal(next.showSource || next.showTranslation, true);
    }
  }
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
