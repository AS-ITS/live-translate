const DEFAULT_RETRY_DELAYS_MS = Object.freeze([0, 250, 1_000]);

export function createProviderRecoveryCoordinator({
  execute,
  wait = defaultWait,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  onStateChange
} = {}) {
  if (typeof execute !== 'function') throw new TypeError('execute is required.');
  if (typeof wait !== 'function') throw new TypeError('wait is required.');
  const delays = normalizeRetryDelays(retryDelaysMs);
  let generation = 0;
  let inFlight = null;
  let state = Object.freeze({ status: 'idle', attempt: 0, operationId: null });

  function publish(next) {
    state = Object.freeze({ ...state, ...next });
    onStateChange?.(state);
    return state;
  }

  function run(operation = {}) {
    assertOperation(operation);
    if (inFlight) {
      if (inFlight.operation.operationId !== operation.operationId) {
        throw recoveryError('provider_recovery_in_progress');
      }
      return inFlight.promise;
    }

    const runGeneration = ++generation;
    const frozenOperation = Object.freeze({ ...operation });
    const promise = runAttempts(frozenOperation, runGeneration).finally(() => {
      if (inFlight?.promise === promise) inFlight = null;
    });
    inFlight = { operation: frozenOperation, promise };
    return promise;
  }

  async function runAttempts(operation, runGeneration) {
    let lastError = null;
    for (let index = 0; index < delays.length; index += 1) {
      const attempt = index + 1;
      if (delays[index] > 0) await wait(delays[index]);
      if (runGeneration !== generation) return publish({ status: 'cancelled', attempt: attempt - 1 });
      publish({ status: 'recovering', attempt, operationId: operation.operationId, manual: operation.manual === true });
      try {
        const ready = await execute({ operation, attempt, generation: runGeneration });
        if (runGeneration !== generation) return publish({ status: 'cancelled', attempt });
        if (ready === true) return publish({ status: 'ready', attempt, lastError: null });
        lastError = recoveryError('provider_recovery_not_ready');
      } catch (error) {
        lastError = error;
      }
    }
    return publish({ status: 'exhausted', attempt: delays.length, lastError });
  }

  function cancel(reason = 'cancelled') {
    generation += 1;
    publish({ status: 'cancelled', reason });
  }

  return Object.freeze({
    run,
    cancel,
    getState: () => state,
    isInFlight: () => Boolean(inFlight),
    currentGeneration: () => generation
  });
}

function normalizeRetryDelays(value) {
  const delays = value === undefined ? DEFAULT_RETRY_DELAYS_MS : value;
  if (!Array.isArray(delays) || delays.length !== 3) {
    throw new TypeError('provider recovery requires exactly three retry delays.');
  }
  return Object.freeze(delays.map((delay) => {
    if (!Number.isFinite(delay) || delay < 0) throw new TypeError('retry delays must be non-negative numbers.');
    return Math.floor(delay);
  }));
}

function assertOperation(operation) {
  if (!operation || typeof operation !== 'object' || typeof operation.operationId !== 'string' || operation.operationId.trim() === '') {
    throw new TypeError('operationId is required.');
  }
}

function recoveryError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function defaultWait(delayMs) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, delayMs));
}
