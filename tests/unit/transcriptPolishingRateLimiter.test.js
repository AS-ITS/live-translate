import assert from 'node:assert/strict';
import test from 'node:test';
import { createTranscriptPolishingRateLimiter } from '../../src/application/translation/transcriptPolishingRateLimiter.js';

test('transcript polishing rate limiter acquires quota immediately', async () => {
  let currentTime = 0;
  const limiter = createTranscriptPolishingRateLimiter({ maxRequestsPerMinute: 2, now: () => currentTime });

  assert.deepEqual(await limiter.acquire(), { acquiredAtMs: 0 });
  currentTime = 1000;
  assert.deepEqual(await limiter.acquire(), { acquiredAtMs: 1000 });
  assert.deepEqual(limiter.state(), { requestCount: 2 });
});

test('transcript polishing rate limiter waits for the earliest sliding-window slot', async () => {
  let currentTime = 0;
  const waits = [];
  const limiter = createTranscriptPolishingRateLimiter({
    maxRequestsPerMinute: 1,
    now: () => currentTime,
    wait: async (delayMs) => {
      waits.push(delayMs);
      currentTime += delayMs;
    }
  });

  await limiter.acquire();
  currentTime = 59999;
  assert.deepEqual(await limiter.acquire(), { acquiredAtMs: 60000 });
  assert.deepEqual(waits, [1]);
  assert.deepEqual(limiter.state(), { requestCount: 1 });
});

test('transcript polishing rate limiter rejects invalid configuration', () => {
  assert.throws(() => createTranscriptPolishingRateLimiter({ maxRequestsPerMinute: 0 }), /positive integer/);
  assert.throws(() => createTranscriptPolishingRateLimiter({ now: null }), /now must be a function/);
  assert.throws(() => createTranscriptPolishingRateLimiter({ wait: null }), /wait must be a function/);
});
