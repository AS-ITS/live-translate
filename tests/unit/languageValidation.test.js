import assert from 'node:assert/strict';
import test from 'node:test';
import { SUPPORTED_LANGUAGES as FRONTEND_LANGUAGES } from '../../src/lib/languages.js';
import { isSupportedLanguage, SUPPORTED_LANGUAGES as BACKEND_LANGUAGES } from '../../server/languages.js';

test('frontend and backend language allowlists stay aligned', () => {
  assert.deepEqual(BACKEND_LANGUAGES, FRONTEND_LANGUAGES);
});

test('language validation accepts supported target language codes', () => {
  for (const language of BACKEND_LANGUAGES) {
    assert.equal(isSupportedLanguage(language.code), true);
  }
});

test('language validation rejects unsupported or malformed codes', () => {
  for (const code of ['xx', '', undefined, null, 'zh-TW']) {
    assert.equal(isSupportedLanguage(code), false);
  }
});
