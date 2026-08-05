export const MEETING_SUMMARY_JOB_REPOSITORY_METHODS = Object.freeze([
  'enqueue', 'get', 'getActiveBySessionId', 'list', 'listAvailable', 'nextAvailableAt',
  'claim', 'retry', 'complete', 'fail', 'reclaimExpired'
]);

export function assertMeetingSummaryJobRepository(repository) {
  if (!repository || typeof repository !== 'object') throw new TypeError('meetingSummaryJobRepository is required.');
  for (const method of MEETING_SUMMARY_JOB_REPOSITORY_METHODS) {
    if (typeof repository[method] !== 'function') throw new TypeError(`meetingSummaryJobRepository.${method} must be a function.`);
  }
}
