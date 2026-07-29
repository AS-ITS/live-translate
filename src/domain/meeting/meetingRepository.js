export const MEETING_REPOSITORY_METHODS = Object.freeze([
  'createMeeting',
  'getMeeting',
  'updateMeeting',
  'listMeetings',
  'createMeetingSegment',
  'getMeetingSegment',
  'listMeetingSegments',
  'updateMeetingSegment'
]);

export function createMeetingRepository() {
  return Object.freeze(
    Object.fromEntries(MEETING_REPOSITORY_METHODS.map((method) => [method, createNotImplementedMethod(method)]))
  );
}

function createNotImplementedMethod(method) {
  return function meetingRepositoryMethod() {
    throw new Error(`MeetingRepository.${method} is not implemented.`);
  };
}
