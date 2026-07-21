const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 10000;

export function createTranslationExecutionRetryPolicy(options = {}) {
  const configuration = normalizeOptions(options);

  return Object.freeze({
    maxAttempts: configuration.maxAttempts,
    baseDelayMs: configuration.baseDelayMs,
    maxDelayMs: configuration.maxDelayMs,
    canRetry(attempt) {
      return normalizeAttempt(attempt) < configuration.maxAttempts;
    },
    getNextDelayMs(attempt, { random = Math.random } = {}) {
      const normalizedAttempt = normalizeAttempt(attempt);
      if (normalizedAttempt === 0) {
        throw new TypeError('translationExecutionRetryPolicy delay attempt must be a positive integer.');
      }
      if (typeof random !== 'function') {
        throw new TypeError('translationExecutionRetryPolicy random must be a function.');
      }
      const cappedDelay = Math.min(
        configuration.baseDelayMs * (2 ** (normalizedAttempt - 1)),
        configuration.maxDelayMs
      );
      const jitter = random();
      if (typeof jitter !== 'number' || !Number.isFinite(jitter) || jitter < 0 || jitter > 1) {
        throw new TypeError('translationExecutionRetryPolicy random must return a number between 0 and 1.');
      }
      return Math.floor(cappedDelay * jitter);
    }
  });
}

function normalizeOptions(options) {
  if (!isRecord(options)) throw new TypeError('translationExecutionRetryPolicy options must be an object.');
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  assertPositiveInteger(maxAttempts, 'translationExecutionRetryPolicy.maxAttempts must be a positive integer.');
  assertNonNegativeInteger(baseDelayMs, 'translationExecutionRetryPolicy.baseDelayMs must be a non-negative integer.');
  assertNonNegativeInteger(maxDelayMs, 'translationExecutionRetryPolicy.maxDelayMs must be a non-negative integer.');
  if (maxDelayMs < baseDelayMs) {
    throw new TypeError('translationExecutionRetryPolicy.maxDelayMs must be greater than or equal to baseDelayMs.');
  }
  return Object.freeze({ maxAttempts, baseDelayMs, maxDelayMs });
}

function normalizeAttempt(attempt) {
  assertNonNegativeInteger(attempt, 'translationExecutionRetryPolicy attempt must be a non-negative integer.');
  return attempt;
}

function assertPositiveInteger(value, message) {
  if (!Number.isInteger(value) || value < 1) throw new TypeError(message);
}

function assertNonNegativeInteger(value, message) {
  if (!Number.isInteger(value) || value < 0) throw new TypeError(message);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
