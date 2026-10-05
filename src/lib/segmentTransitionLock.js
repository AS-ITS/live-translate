/**
 * Allows only one meeting-segment transition to mutate a segment at a time.
 *
 * Rollover and provider recovery use different HTTP endpoints, but both
 * create the next segment. A synchronous lock closes that race before either
 * operation starts an asynchronous request.
 */
export function createSegmentTransitionLock() {
  const activeKeys = new Set();

  function tryAcquire(key) {
    assertKey(key);
    if (activeKeys.has(key)) return null;

    activeKeys.add(key);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      activeKeys.delete(key);
    };
  }

  function isLocked(key) {
    assertKey(key);
    return activeKeys.has(key);
  }

  return Object.freeze({ tryAcquire, isLocked });
}

function assertKey(key) {
  if (typeof key !== 'string' || key.trim().length === 0) {
    throw new TypeError('segment transition key must be a non-empty string.');
  }
}
