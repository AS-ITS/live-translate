export const TRANSLATION_EXECUTION_RETRY_REASONS = Object.freeze({
  GEMINI_RATE_LIMITED: 'gemini_rate_limited',
  GEMINI_SERVER_ERROR: 'gemini_server_error',
  GEMINI_CLIENT_ERROR: 'gemini_client_error',
  TRANSIENT_ERROR: 'transient_error',
  VALIDATION_OR_DOMAIN_ERROR: 'validation_or_domain_error',
  UNKNOWN_ERROR: 'unknown_error'
});

export function createTranslationExecutionRetryErrorClassifier() {
  return Object.freeze({
    classify(error) {
      if (isGeminiHttpError(error)) {
        if (error.status === 429) return classification(true, TRANSLATION_EXECUTION_RETRY_REASONS.GEMINI_RATE_LIMITED);
        if (error.status >= 500 && error.status <= 599) {
          return classification(true, TRANSLATION_EXECUTION_RETRY_REASONS.GEMINI_SERVER_ERROR);
        }
        return classification(false, TRANSLATION_EXECUTION_RETRY_REASONS.GEMINI_CLIENT_ERROR);
      }
      if (isExplicitTransientError(error)) {
        return classification(true, TRANSLATION_EXECUTION_RETRY_REASONS.TRANSIENT_ERROR);
      }
      if (error instanceof TypeError || error instanceof RangeError || isNamedDomainOrValidationError(error)) {
        return classification(false, TRANSLATION_EXECUTION_RETRY_REASONS.VALIDATION_OR_DOMAIN_ERROR);
      }
      return classification(false, TRANSLATION_EXECUTION_RETRY_REASONS.UNKNOWN_ERROR);
    }
  });
}

function isGeminiHttpError(error) {
  return error !== null && typeof error === 'object' && error.name === 'GeminiHttpError' && Number.isInteger(error.status);
}

function isExplicitTransientError(error) {
  return error !== null && typeof error === 'object'
    && (error.transient === true || error.isTransient === true || error.retryable === true);
}

function isNamedDomainOrValidationError(error) {
  return error !== null && typeof error === 'object'
    && (error.name === 'ValidationError' || error.name === 'DomainError');
}

function classification(retryable, reason) {
  return Object.freeze({ retryable, reason });
}
