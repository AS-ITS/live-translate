import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_VIEWER_FONT_SIZE,
  normalizeViewerFontSize,
  readViewerFontSizePreference,
  VIEWER_FONT_SIZE_STORAGE_KEY,
  writeViewerFontSizePreference
} from '../../src/lib/viewerFontSizePreference.js';

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, value);
    }
  };
}

test('Viewer font size defaults invalid or missing values to medium', () => {
  assert.equal(normalizeViewerFontSize('large'), 'large');
  assert.equal(normalizeViewerFontSize('unexpected'), DEFAULT_VIEWER_FONT_SIZE);
  assert.equal(readViewerFontSizePreference(memoryStorage()), DEFAULT_VIEWER_FONT_SIZE);
  assert.equal(readViewerFontSizePreference(memoryStorage({
    [VIEWER_FONT_SIZE_STORAGE_KEY]: 'unexpected'
  })), DEFAULT_VIEWER_FONT_SIZE);
});

test('Viewer font size preference persists a normalized value', () => {
  const storage = memoryStorage();
  assert.equal(writeViewerFontSizePreference('small', storage), 'small');
  assert.equal(readViewerFontSizePreference(storage), 'small');
  assert.equal(writeViewerFontSizePreference('invalid', storage), DEFAULT_VIEWER_FONT_SIZE);
  assert.equal(readViewerFontSizePreference(storage), DEFAULT_VIEWER_FONT_SIZE);
});
