import assert from 'node:assert/strict';
import test from 'node:test';
import { createTranscriptPolishingRateLimiter } from '../../src/application/translation/transcriptPolishingRateLimiter.js';

test('transcript polishing rate limiter allows configured requests and returns the next slot', () => {
  const limiter = createTranscriptPolishingRateLimiter({ maxRequestsPerMinute: 2 });

  assert.deepEqual(limiter.tryAcquire(0), { allowed: true, availableAtMs: null });
  assert.deepEqual(limiter.tryAcquire(1000), { allowed: true, availableAtMs: null });
  assert.deepEqual(limiter.tryAcquire(2000), { allowed: false, availableAtMs: 60000 });
  assert.deepEqual(limiter.tryAcquire(60000), { allowed: true, availableAtMs: null });
});

test('transcript polishing rate limiter evicts requests outside the sliding window', () => {
  const limiter = createTranscriptPolishingRateLimiter({ maxRequestsPerMinute: 1 });

  assert.equal(limiter.tryAcquire(0).allowed, true);
  assert.equal(limiter.tryAcquire(59999).allowed, false);
  assert.equal(limiter.tryAcquire(60000).allowed, true);
  assert.deepEqual(limiter.state(), { requestCount: 1 });
});
