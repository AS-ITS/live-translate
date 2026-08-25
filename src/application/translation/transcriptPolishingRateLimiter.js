const WINDOW_MS = 60000;

export function createTranscriptPolishingRateLimiter({
  maxRequestsPerMinute = 15,
  now = () => Date.now(),
  wait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs))
} = {}) {
  if (!Number.isInteger(maxRequestsPerMinute) || maxRequestsPerMinute <= 0) {
    throw new TypeError('maxRequestsPerMinute must be a positive integer.');
  }
  if (typeof now !== 'function') throw new TypeError('now must be a function.');
  if (typeof wait !== 'function') throw new TypeError('wait must be a function.');

  const requestTimes = [];

  function prune(nowMs) {
    while (requestTimes[0] !== undefined && nowMs - requestTimes[0] >= WINDOW_MS) requestTimes.shift();
  }

  async function acquire() {
    while (true) {
      const nowMs = now();
      if (!Number.isFinite(nowMs)) throw new TypeError('now() must return a finite number.');
      prune(nowMs);
      if (requestTimes.length < maxRequestsPerMinute) {
        requestTimes.push(nowMs);
        return { acquiredAtMs: nowMs };
      }

      const delayMs = Math.max(0, requestTimes[0] + WINDOW_MS - nowMs);
      await wait(delayMs);
    }
  }

  function state() {
    const nowMs = now();
    if (!Number.isFinite(nowMs)) throw new TypeError('now() must return a finite number.');
    prune(nowMs);
    return { requestCount: requestTimes.length };
  }

  return Object.freeze({
    acquire,
    state
  });
}
