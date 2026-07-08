import { createRetryState, nextRetryDecision, recordRetryAttempt, resetRetryState } from './retryPolicy.js';

export function createReconnectController(options = {}) {
  const cleanup = typeof options.cleanup === 'function' ? options.cleanup : () => {};
  const executeReconnect = typeof options.executeReconnect === 'function' ? options.executeReconnect : async () => {};
  const timer = normalizeTimer(options.timer);
  const now = typeof options.now === 'function' ? options.now : () => 0;
  const retryOptions = options.retryOptions || {};

  let state = 'idle';
  let generationId = 0;
  let retryState = createRetryState(retryOptions);
  let pendingTimer = null;
  let pendingDecision = null;
  let pendingClassification = null;
  let lastScheduleResult = null;
  let needsNewLifecycle = true;

  function start() {
    clearPendingTimer();
    generationId += 1;
    retryState = resetRetryState(retryOptions);
    pendingDecision = null;
    pendingClassification = null;
    lastScheduleResult = null;
    needsNewLifecycle = false;
    state = 'running';
    return snapshot();
  }

  function stop() {
    clearPendingTimer();
    generationId += 1;
    pendingDecision = null;
    pendingClassification = null;
    lastScheduleResult = null;
    needsNewLifecycle = true;
    if (state !== 'cancelled') {
      state = 'completed';
    }
    return snapshot();
  }

  async function scheduleReconnect(classification) {
    if (state === 'cancelled') {
      return ignoredResult();
    }

    if (pendingTimer || state === 'scheduled' || state === 'running') {
      return ignoredResult();
    }

    if (state === 'idle' || needsNewLifecycle) {
      start();
    }

    const callbackGeneration = generationId;
    state = 'running';

    await cleanup({ classification, generationId: callbackGeneration });

    if (!isCurrent(callbackGeneration) || state === 'cancelled') {
      return ignoredResult(callbackGeneration);
    }

    const decision = nextRetryDecision(retryState, classification, {
      ...retryOptions,
      now: now()
    });

    if (!decision.shouldRetry || decision.paused) {
      pendingDecision = null;
      pendingClassification = null;
      needsNewLifecycle = true;
      lastScheduleResult = {
        scheduled: false,
        generationId: callbackGeneration,
        decision,
        state: 'completed'
      };
      state = 'completed';
      return lastScheduleResult;
    }

    retryState = recordRetryAttempt(retryState, decision, now());
    pendingDecision = decision;
    pendingClassification = classification;
    state = 'scheduled';

    pendingTimer = timer.set(
      () => executeScheduledReconnect({
        classification,
        decision,
        generationId: callbackGeneration
      }),
      decision.delayMs
    );

    lastScheduleResult = {
      scheduled: true,
      generationId: callbackGeneration,
      decision,
      state: 'scheduled'
    };
    return lastScheduleResult;
  }

  function cancel() {
    clearPendingTimer();
    generationId += 1;
    pendingDecision = null;
    pendingClassification = null;
    lastScheduleResult = null;
    needsNewLifecycle = true;
    state = 'cancelled';
    return snapshot();
  }

  function reset() {
    clearPendingTimer();
    generationId += 1;
    retryState = resetRetryState(retryOptions);
    pendingDecision = null;
    pendingClassification = null;
    lastScheduleResult = null;
    needsNewLifecycle = true;
    state = 'idle';
    return snapshot();
  }

  function currentState() {
    return state;
  }

  function currentGeneration() {
    return generationId;
  }

  function isCurrent(callbackGeneration) {
    return callbackGeneration === generationId;
  }

  function clearPendingTimer() {
    if (pendingTimer) {
      timer.clear(pendingTimer);
      pendingTimer = null;
    }
  }

  async function executeScheduledReconnect({ classification, decision, generationId: callbackGeneration }) {
    if (!isCurrent(callbackGeneration) || state === 'cancelled') {
      return;
    }

    pendingTimer = null;
    pendingDecision = null;
    pendingClassification = null;
    state = 'running';

    try {
      await executeReconnect({
        classification,
        decision,
        generationId: callbackGeneration
      });
    } catch {
      // Execution failures are terminal for this skeleton attempt.
    }

    if (!isCurrent(callbackGeneration) || state === 'cancelled') {
      return;
    }

    state = 'completed';
  }

  function ignoredResult(callbackGeneration = generationId) {
    return {
      ignored: true,
      generationId: callbackGeneration,
      decision: pendingDecision || lastScheduleResult?.decision || null,
      classification: pendingClassification,
      state
    };
  }

  function snapshot() {
    return {
      state,
      generationId
    };
  }

  return {
    start,
    stop,
    scheduleReconnect,
    cancel,
    reset,
    currentState,
    currentGeneration
  };
}

function normalizeTimer(timer) {
  if (timer && typeof timer.set === 'function' && typeof timer.clear === 'function') {
    return timer;
  }

  return {
    set: (callback, delayMs) => setTimeout(callback, delayMs),
    clear: (handle) => clearTimeout(handle)
  };
}
