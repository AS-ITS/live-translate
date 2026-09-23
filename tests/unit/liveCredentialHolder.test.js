import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearLiveCredential,
  getLiveCredential,
  hasLiveCredential,
  resetLiveCredentialForTest,
  setLiveCredential
} from '../../src/lib/liveCredentialHolder.js';

test.afterEach(() => resetLiveCredentialForTest());

test('keeps the Gemini API Key only in lifecycle memory until cleared', () => {
  assert.equal(hasLiveCredential(), false);
  assert.equal(getLiveCredential(), null);

  assert.equal(setLiveCredential('  test-api-key  '), true);
  assert.equal(hasLiveCredential(), true);
  assert.equal(getLiveCredential(), 'test-api-key');

  clearLiveCredential();
  assert.equal(hasLiveCredential(), false);
  assert.equal(getLiveCredential(), null);
});
