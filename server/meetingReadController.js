export function createMeetingReadController({ meetingReadQueryService } = {}) {
  assertMeetingReadQueryService(meetingReadQueryService);

  return {
    listMeetings() {
      return meetingReadQueryService.listMeetingHistory();
    },

    getMeeting(meetingId) {
      return meetingReadQueryService.getMeetingDetail(meetingId);
    },

    getMeetingViewerPage(meetingId, options) {
      if (typeof meetingReadQueryService.getMeetingViewerPage === 'function') {
        return meetingReadQueryService.getMeetingViewerPage(meetingId, options);
      }
      return meetingReadQueryService.getMeetingDetail(meetingId);
    }
  };
}

function assertMeetingReadQueryService(meetingReadQueryService) {
  if (!meetingReadQueryService) {
    throw new TypeError('meetingReadQueryService is required.');
  }

  for (const method of ['listMeetingHistory', 'getMeetingDetail']) {
    if (typeof meetingReadQueryService[method] !== 'function') {
      throw new TypeError(`meetingReadQueryService.${method} must be a function.`);
    }
  }
}
