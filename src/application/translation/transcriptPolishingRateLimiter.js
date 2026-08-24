export function createTranscriptPolishingRateLimiter({ maxRequestsPerMinute = 15 } = {}) {
  if (!Number.isInteger(maxRequestsPerMinute) || maxRequestsPerMinute <= 0) {
    throw new TypeError('maxRequestsPerMinute must be a positive integer.');
  }

  const requestTimes = [];

  function tryAcquire(nowMs) {
    if (!Number.isFinite(nowMs)) throw new TypeError('nowMs must be finite.');
    while (requestTimes[0] !== undefined && nowMs - requestTimes[0] >= 60000) requestTimes.shift();
    if (requestTimes.length >= maxRequestsPerMinute) {
      return { allowed: false, availableAtMs: requestTimes[0] + 60000 };
    }
    requestTimes.push(nowMs);
    return { allowed: true, availableAtMs: null };
  }

  return Object.freeze({
    tryAcquire,
    state: () => ({ requestCount: requestTimes.length })
  });
}
