/**
 * Coordinates recovery work for one meeting segment.
 *
 * A settled entry is retained until the caller explicitly clears the key. This
 * matters because a second provider callback can arrive just after the first
 * recovery request completed, when the server has already created the next
 * segment and would correctly reject another request for the old segment.
 */
export function createRecoverySingleFlight() {
  const inFlight = new Map();
  const settled = new Map();

  function run(key, operation) {
    assertKey(key);
    if (typeof operation !== 'function') {
      throw new TypeError('recovery operation must be a function.');
    }

    const current = inFlight.get(key);
    if (current) return current;

    const completed = settled.get(key);
    if (completed) {
      return completed.ok
        ? Promise.resolve(completed.value)
        : Promise.reject(completed.error);
    }

    const promise = Promise.resolve().then(operation);
    const tracked = promise.then(
      (value) => {
        inFlight.delete(key);
        settled.set(key, { ok: true, value });
        return value;
      },
      (error) => {
        inFlight.delete(key);
        settled.set(key, { ok: false, error });
        throw error;
      }
    );
    inFlight.set(key, tracked);
    return tracked;
  }

  function clear(key) {
    assertKey(key);
    inFlight.delete(key);
    settled.delete(key);
  }

  function clearAll() {
    inFlight.clear();
    settled.clear();
  }

  function isInFlight(key) {
    return inFlight.has(key);
  }

  function hasSettled(key) {
    return settled.has(key);
  }

  return Object.freeze({ run, clear, clearAll, isInFlight, hasSettled });
}

function assertKey(key) {
  if (typeof key !== 'string' || key.trim().length === 0) {
    throw new TypeError('recovery key must be a non-empty string.');
  }
}

