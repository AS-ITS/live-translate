export function createSessionSummaryQueryService({ summaryRepository } = {}) {
  if (!summaryRepository || typeof summaryRepository.getSummaryBySessionId !== 'function') {
    throw new TypeError('summaryRepository.getSummaryBySessionId must be a function.');
  }

  return Object.freeze({
    getSessionSummary(sessionId) {
      if (typeof sessionId !== 'string' || sessionId.trim() === '') throw new TypeError('sessionId must be a non-empty string.');
      return summaryRepository.getSummaryBySessionId(sessionId);
    }
  });
}
