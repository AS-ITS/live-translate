export function createMeetingReadController({ meetingReadQueryService } = {}) {
  assertMeetingReadQueryService(meetingReadQueryService);

  return {
    listMeetings(actor = {}) {
      return meetingReadQueryService.listMeetingHistory(readOptions(actor));
    },

    getMeeting(meetingId, actor = {}) {
      return meetingReadQueryService.getMeetingDetail(meetingId, readOptions(actor));
    },

    getMeetingViewerPage(meetingId, options) {
      if (typeof meetingReadQueryService.getMeetingViewerPage === 'function') {
        return meetingReadQueryService.getMeetingViewerPage(meetingId, options);
      }
      return meetingReadQueryService.getMeetingDetail(meetingId);
    }
  };
}

function readOptions(actor) {
  return {
    actorUserId: actor?.id || null,
    isSystemAdmin: actor?.role === 'super_admin' && actor?.status === 'active'
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
