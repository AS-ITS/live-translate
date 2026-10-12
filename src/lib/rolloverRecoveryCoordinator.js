const DEFAULT_RETRY_DELAYS_MS = Object.freeze([250, 1_000, 3_000]);

export function createRolloverRecoveryCoordinator({
  execute,
  reconcile,
  wait = defaultWait,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  onStateChange,
  persist
} = {}) {
  if (typeof execute !== 'function') throw new TypeError('execute is required.');
  if (typeof reconcile !== 'function') throw new TypeError('reconcile is required.');
  if (typeof wait !== 'function') throw new TypeError('wait is required.');

  const delays = normalizeRetryDelays(retryDelaysMs);
  let inFlight = null;
  let state = Object.freeze({ status: 'idle', attempt: 0, operationId: null });

  const publish = async (next) => {
    state = Object.freeze({ ...state, ...next });
    onStateChange?.(state);
    await persist?.(state);
    return state;
  };

  const run = (operationInput) => {
    const operation = freezeOperation(operationInput);
    if (inFlight) {
      if (inFlight.operation.operationId !== operation.operationId) {
        throw rolloverError('rollover_in_progress', 'Another rollover is already in progress.');
      }
      assertSameOperation(inFlight.operation, operation);
      return inFlight.promise;
    }

    const promise = runOperation(operation).finally(() => {
      if (inFlight?.promise === promise) inFlight = null;
    });
    inFlight = { operation, promise };
    return promise;
  };

  async function runOperation(operation) {
    await publish({ status: 'running', attempt: 1, operationId: operation.operationId, operation });
    let lastError = null;

    for (let attempt = 1; attempt <= delays.length + 1; attempt += 1) {
      if (attempt > 1) {
        await publish({ status: 'reconciling', attempt, lastError });
        const resolution = await reconcile({ operation, error: lastError, attempt });
        if (resolution?.status === 'committed') {
          await publish({ status: 'succeeded', attempt, result: resolution.result, authoritativeSegment: resolution.authoritativeSegment });
          return resolution.result;
        }
        if (resolution?.status !== 'source-active') {
          const error = rolloverError('rollover_reconciliation_conflict', 'Authoritative Segment cannot safely accept this rollover retry.');
          error.resolution = resolution;
          await publish({ status: 'recoverable-failure', attempt, lastError: error, authoritativeSegment: resolution?.authoritativeSegment });
          throw error;
        }
        await wait(delays[attempt - 2]);
        await publish({ status: 'running', attempt });
      }

      try {
        const result = await execute({ operation, attempt });
        await publish({ status: 'succeeded', attempt, result, authoritativeSegment: result?.segment || null });
        return result;
      } catch (error) {
        lastError = error;
        const canRetry = isRetryableRolloverError(error);
        const hasRetry = attempt <= delays.length;
        if (!canRetry || !hasRetry) {
          if (error?.outcomeUnknown || error?.status === 409) {
            await publish({ status: 'reconciling', attempt, lastError: error });
            const resolution = await reconcile({ operation, error, attempt });
            if (resolution?.status === 'committed') {
              await publish({ status: 'succeeded', attempt, result: resolution.result, authoritativeSegment: resolution.authoritativeSegment });
              return resolution.result;
            }
          }
          await publish({ status: 'recoverable-failure', attempt, lastError: error });
          throw error;
        }
      }
    }

    throw lastError;
  }

  return Object.freeze({
    run,
    getState: () => state,
    isInFlight: () => Boolean(inFlight)
  });
}

export function isRetryableRolloverError(error) {
  if (error?.outcomeUnknown || error?.code === 'request_timeout') return true;
  if (!Number.isInteger(error?.status)) return true;
  return error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500;
}

function freezeOperation(value = {}) {
  if (!value.operationId || typeof value.operationId !== 'string') throw new TypeError('operationId is required.');
  if (!value.payload || typeof value.payload !== 'object') throw new TypeError('payload is required.');
  return Object.freeze({ ...value, payload: deepFreezeClone(value.payload) });
}

function assertSameOperation(left, right) {
  if (stableJson(left.payload) !== stableJson(right.payload)) {
    throw rolloverError('rollover_operation_payload_conflict', 'The same operationId cannot be reused with a different payload.');
  }
}

function deepFreezeClone(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(deepFreezeClone));
  if (!value || typeof value !== 'object') return value;
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deepFreezeClone(item)])));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function normalizeRetryDelays(value) {
  if (!Array.isArray(value)) return DEFAULT_RETRY_DELAYS_MS;
  return Object.freeze(value.map((delay) => {
    if (!Number.isFinite(delay) || delay < 0) throw new TypeError('retry delays must be non-negative numbers.');
    return Math.floor(delay);
  }));
}

function rolloverError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function defaultWait(delayMs) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, delayMs));
}
