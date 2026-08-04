const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 30000;

export function createMeetingSummaryRetryPolicy({ maxAttempts = DEFAULT_MAX_ATTEMPTS, baseDelayMs = DEFAULT_BASE_DELAY_MS, maxDelayMs = DEFAULT_MAX_DELAY_MS } = {}) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new TypeError('maxAttempts must be a positive integer.');
  if (!Number.isInteger(baseDelayMs) || baseDelayMs < 0) throw new TypeError('baseDelayMs must be a non-negative integer.');
  if (!Number.isInteger(maxDelayMs) || maxDelayMs < baseDelayMs) throw new TypeError('maxDelayMs must be greater than or equal to baseDelayMs.');
  return Object.freeze({
    maxAttempts,
    canRetry(attempt) { return Number.isInteger(attempt) && attempt < maxAttempts; },
    getNextDelayMs(attempt) { return Math.min(baseDelayMs * (2 ** Math.max(0, attempt - 1)), maxDelayMs); }
  });
}

export function createMeetingSummaryRetryErrorClassifier() {
  return Object.freeze({
    classify(error) {
      if (error?.retryable === true || error?.transient === true || error?.isTransient === true) return { retryable: true, reason: 'transient_error' };
      if (error?.name === 'GeminiHttpError' && Number.isInteger(error.status)) return { retryable: error.status === 429 || error.status >= 500, reason: `gemini_http_${error.status}` };
      if (error instanceof TypeError || error instanceof RangeError || error?.name === 'ValidationError' || error?.name === 'DomainError') return { retryable: false, reason: 'validation_or_domain_error' };
      return { retryable: false, reason: 'unknown_error' };
    }
  });
}
