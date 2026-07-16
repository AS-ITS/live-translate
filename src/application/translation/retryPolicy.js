const DEFAULT_MAX_RETRIES = 0;
const DEFAULT_DELAY_STRATEGY = 'none';

export function createRetryPolicy(options = {}) {
  const configuration = normalizeRetryPolicyOptions(options);

  return Object.freeze({
    maxRetries: configuration.maxRetries,
    delayStrategy: configuration.delayStrategy,

    canRetry(attempt) {
      const normalizedAttempt = normalizeAttempt(attempt);
      return normalizedAttempt <= configuration.maxRetries;
    },

    nextDelay() {
      return 0;
    }
  });
}

function normalizeRetryPolicyOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('retryPolicy options must be an object.');
  }

  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const delayStrategy = options.delayStrategy ?? DEFAULT_DELAY_STRATEGY;

  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new TypeError('retryPolicy.maxRetries must be a non-negative integer.');
  }

  if (!isValidDelayStrategy(delayStrategy)) {
    throw new TypeError('retryPolicy.delayStrategy must be a string or function.');
  }

  return Object.freeze({
    maxRetries,
    delayStrategy
  });
}

function normalizeAttempt(attempt) {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new TypeError('retryPolicy attempt must be a positive integer.');
  }

  return attempt;
}

function isValidDelayStrategy(delayStrategy) {
  return typeof delayStrategy === 'string' || typeof delayStrategy === 'function';
}
