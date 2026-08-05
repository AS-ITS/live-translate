export const MEETING_SUMMARY_REPOSITORY_METHODS = Object.freeze([
  'createSummary',
  'getSummary',
  'getSummaryBySessionId',
  'getSummaryByRange',
  'listPartialSummariesBySessionId',
  'listSummariesBySessionId',
  'updateSummary'
]);

export function createMeetingSummaryRepository() {
  return Object.freeze(Object.fromEntries(MEETING_SUMMARY_REPOSITORY_METHODS.map((method) => [method, () => {
    throw new Error(`MeetingSummaryRepository.${method} is not implemented.`);
  }])));
}
