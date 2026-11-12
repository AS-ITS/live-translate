import assert from 'node:assert/strict';
import test from 'node:test';
import { hasSmokeGeminiKey } from '../e2e/issue41GeminiKey.js';

test('smoke key check accepts a non-placeholder key without a fixed prefix', () => {
  assert.equal(hasSmokeGeminiKey('fictional-prefix-credential-123456'), true);
});

test('smoke key check rejects missing and obvious placeholder values', () => {
  for (const value of [undefined, '', '   ', 'test', 'placeholder', 'your-api-key', 'replace-me']) {
    assert.equal(hasSmokeGeminiKey(value), false);
  }
});

test('smoke key check rejects embedded whitespace', () => {
  assert.equal(hasSmokeGeminiKey('fictional credential 123456'), false);
});
