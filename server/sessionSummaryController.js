export function createSessionSummaryController({ sessionSummaryQueryService } = {}) {
  if (!sessionSummaryQueryService || typeof sessionSummaryQueryService.getSessionSummary !== 'function') {
    throw new TypeError('sessionSummaryQueryService.getSessionSummary must be a function.');
  }

  return Object.freeze({
    getSessionSummary(sessionId) {
      return sessionSummaryQueryService.getSessionSummary(sessionId);
    }
  });
}
