import assert from 'node:assert/strict';
import test from 'node:test';
import { GeminiHttpError } from '../../src/infrastructure/geminiClient.js';
import { createTranslationExecutionRetryErrorClassifier, TRANSLATION_EXECUTION_RETRY_REASONS } from '../../src/application/translation/translationExecutionRetryErrorClassifier.js';

test('classifies Gemini rate limits and server errors as retryable', () => {
  const classifier = createTranslationExecutionRetryErrorClassifier();
  for (const status of [429, 500, 503]) {
    assert.equal(classifier.classify(new GeminiHttpError({ status, code: 'failed', message: 'failed' })).retryable, true);
  }
  assert.equal(classifier.classify(new GeminiHttpError({ status: 429, code: 'failed', message: 'failed' })).reason, TRANSLATION_EXECUTION_RETRY_REASONS.GEMINI_RATE_LIMITED);
});

test('classifies explicitly transient errors as retryable', () => {
  const classifier = createTranslationExecutionRetryErrorClassifier();
  assert.deepEqual(classifier.classify(Object.assign(new Error('temporary'), { transient: true })), {
    retryable: true, reason: TRANSLATION_EXECUTION_RETRY_REASONS.TRANSIENT_ERROR
  });
});

test('classifies Gemini client, validation, domain, and unknown errors as non-retryable', () => {
  const classifier = createTranslationExecutionRetryErrorClassifier();
  for (const error of [
    new GeminiHttpError({ status: 400, code: 'bad_request', message: 'bad' }),
    new GeminiHttpError({ status: 401, code: 'unauthorized', message: 'no' }),
    new GeminiHttpError({ status: 403, code: 'forbidden', message: 'no' }),
    new TypeError('invalid'), Object.assign(new Error('domain'), { name: 'DomainError' }), new Error('unknown')
  ]) assert.equal(classifier.classify(error).retryable, false);
  assert.equal(classifier.classify(new Error('unknown')).reason, TRANSLATION_EXECUTION_RETRY_REASONS.UNKNOWN_ERROR);
});
