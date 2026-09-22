const DEFAULT_SYNC_DELAY_MS = 1000;

export function createSessionSnapshotSyncCoordinator({
  syncSessionSnapshot,
  onError,
  delayMs = DEFAULT_SYNC_DELAY_MS,
  setTimeoutFn = globalThis.setTimeout,
  clearTimeoutFn = globalThis.clearTimeout
} = {}) {
  if (typeof syncSessionSnapshot !== 'function') {
    throw new TypeError('syncSessionSnapshot is required.');
  }
  if (typeof setTimeoutFn !== 'function') {
    throw new TypeError('setTimeoutFn is required.');
  }
  if (typeof clearTimeoutFn !== 'function') {
    throw new TypeError('clearTimeoutFn is required.');
  }

  const pendingSessionIds = new Set();
  const blockedSessionIds = new Set();
  let timer = null;
  let queue = Promise.resolve();

  return Object.freeze({
    schedule(sessionId) {
      if (!validSessionId(sessionId)) return;
      if (blockedSessionIds.has(sessionId)) return;

      pendingSessionIds.add(sessionId);
      if (timer) return;

      timer = setTimeoutFn(() => {
        timer = null;
        const sessionIds = drainPendingSessionIds();
        void enqueueSync(sessionIds);
      }, Math.max(0, delayMs));
    },

    flush(sessionId, { retryBlocked = false } = {}) {
      if (timer) {
        clearTimeoutFn(timer);
        timer = null;
      }

      const sessionIds = validSessionId(sessionId)
        ? [...drainPendingSessionIds(), sessionId]
        : drainPendingSessionIds();
      if (validSessionId(sessionId)) {
        pendingSessionIds.delete(sessionId);
      }

      if (validSessionId(sessionId) && retryBlocked) blockedSessionIds.delete(sessionId);
      return enqueueSync(sessionIds, { force: retryBlocked });
    },

    retry(sessionId) {
      return this.flush(sessionId, { retryBlocked: true });
    },

    cancel() {
      if (timer) {
        clearTimeoutFn(timer);
        timer = null;
      }
      pendingSessionIds.clear();
      blockedSessionIds.clear();
    }
  });

  function drainPendingSessionIds() {
    const sessionIds = Array.from(pendingSessionIds);
    pendingSessionIds.clear();
    return sessionIds;
  }

  function enqueueSync(sessionIds, { force = false } = {}) {
    const uniqueSessionIds = Array.from(new Set(sessionIds.filter((sessionId) => (
      validSessionId(sessionId) && (force || !blockedSessionIds.has(sessionId))
    ))));
    if (uniqueSessionIds.length === 0) {
      return queue;
    }

    queue = queue.then(async () => {
      let ok = true;
      for (const sessionId of uniqueSessionIds) {
        try {
          await syncSessionSnapshot(sessionId);
          blockedSessionIds.delete(sessionId);
        } catch (error) {
          ok = false;
          if (isCloudCapabilityUnavailable(error)) blockedSessionIds.add(sessionId);
          onError?.(error, sessionId);
        }
      }
      return ok;
    });

    return queue;
  }
}

function isCloudCapabilityUnavailable(error) {
  return error?.status === 503
    || error?.code === 'cloud_capability_unavailable'
    || error?.code === 'supabase_unavailable'
    || error?.code === 'supabase_request_failed';
}

function validSessionId(sessionId) {
  return typeof sessionId === 'string' && sessionId.trim().length > 0;
}
