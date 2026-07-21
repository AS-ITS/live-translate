import assert from 'node:assert/strict';
import test from 'node:test';
import { createTranslationExecutionRetryPolicy } from '../../src/application/translation/translationExecutionRetryPolicy.js';

test('uses the queue retry defaults', () => {
  const policy = createTranslationExecutionRetryPolicy();
  assert.deepEqual(
    { maxAttempts: policy.maxAttempts, baseDelayMs: policy.baseDelayMs, maxDelayMs: policy.maxDelayMs },
    { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 10000 }
  );
});

test('validates queue retry configuration deterministically', () => {
  for (const options of [null, { maxAttempts: 0 }, { maxAttempts: 1.5 }, { baseDelayMs: -1 }, { maxDelayMs: -1 }, { baseDelayMs: 1001, maxDelayMs: 1000 }]) {
    assert.throws(() => createTranslationExecutionRetryPolicy(options), TypeError);
  }
});

test('canRetry uses executed-attempt boundaries', () => {
  const policy = createTranslationExecutionRetryPolicy({ maxAttempts: 3 });
  assert.equal(policy.canRetry(0), true);
  assert.equal(policy.canRetry(1), true);
  assert.equal(policy.canRetry(2), true);
  assert.equal(policy.canRetry(3), false);
  assert.throws(() => policy.canRetry(-1), TypeError);
});

test('getNextDelayMs uses capped exponential full jitter with an injected random source', () => {
  const policy = createTranslationExecutionRetryPolicy({ baseDelayMs: 1000, maxDelayMs: 2500 });
  const random = () => 0.5;
  assert.equal(policy.getNextDelayMs(1, { random }), 500);
  assert.equal(policy.getNextDelayMs(2, { random }), 1000);
  assert.equal(policy.getNextDelayMs(3, { random }), 1250);
  assert.equal(policy.getNextDelayMs(10, { random: () => 1 }), 2500);
  assert.throws(() => policy.getNextDelayMs(0, { random }), TypeError);
  assert.throws(() => policy.getNextDelayMs(1, { random: () => 1.1 }), TypeError);
});
