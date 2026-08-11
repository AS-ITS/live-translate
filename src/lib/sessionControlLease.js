const DEFAULT_KEY = 'live-translate:session-control';
const DEFAULT_HEARTBEAT_MS = 2000;
const DEFAULT_TTL_MS = 6000;

export function createSessionControlLease({
  storage = globalThis.localStorage,
  key = DEFAULT_KEY,
  clock = () => Date.now(),
  tabId = createTabId(),
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
  ttlMs = DEFAULT_TTL_MS,
  eventTarget = globalThis
} = {}) {
  const listeners = new Set();
  let ownedSessionId = null;
  let heartbeatTimer = null;

  function readLease() {
    try {
      const raw = storage?.getItem(key);
      if (!raw) return null;
      const value = JSON.parse(raw);
      if (!value || typeof value !== 'object' || typeof value.sessionId !== 'string' || typeof value.tabId !== 'string' || !Number.isFinite(value.updatedAt)) {
        return null;
      }
      return value;
    } catch {
      return null;
    }
  }

  function writeLease(sessionId) {
    const value = { sessionId, tabId, updatedAt: clock() };
    try {
      storage?.setItem(key, JSON.stringify(value));
    } catch {
      return false;
    }
    notify(value);
    return true;
  }

  function clearLease() {
    const current = readLease();
    if (current?.tabId !== tabId) return;
    try {
      storage?.removeItem(key);
    } catch {
      // Storage can be unavailable in private browsing or restricted frames.
    }
    notify(null);
  }

  function isExpired(value) {
    return !value || clock() - value.updatedAt >= ttlMs;
  }

  function notify(value = readLease()) {
    const snapshot = value && !isExpired(value) ? { ...value } : null;
    for (const listener of listeners) listener(snapshot);
  }

  function stopHeartbeat() {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (ownedSessionId) writeLease(ownedSessionId);
    }, heartbeatMs);
  }

  function tryAcquire(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.trim() === '') return false;
    const current = readLease();
    if (current && !isExpired(current) && current.tabId !== tabId) {
      notify(current);
      return false;
    }
    if (!writeLease(sessionId)) return false;
    ownedSessionId = sessionId;
    startHeartbeat();
    return true;
  }

  function release(sessionId = ownedSessionId) {
    if (!sessionId || ownedSessionId !== sessionId) return;
    ownedSessionId = null;
    stopHeartbeat();
    clearLease();
  }

  function owns(sessionId) {
    return Boolean(sessionId && ownedSessionId === sessionId && readLease()?.tabId === tabId && !isExpired(readLease()));
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function.');
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function handleStorage(event) {
    if (event?.key === key) notify();
  }

  eventTarget?.addEventListener?.('storage', handleStorage);

  return Object.freeze({
    tryAcquire,
    release,
    owns,
    subscribe,
    current() {
      const current = readLease();
      return current && !isExpired(current) ? { ...current } : null;
    },
    destroy() {
      release();
      stopHeartbeat();
      eventTarget?.removeEventListener?.('storage', handleStorage);
      listeners.clear();
    }
  });
}

function createTabId() {
  return `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
