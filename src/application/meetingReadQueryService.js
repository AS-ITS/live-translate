import {
  mapMeetingToDetailDTO,
  mapMeetingToHistoryListItem
} from '../readModels/meetingReadModels.js';

export function createMeetingReadQueryService({ meetingRepository, sessionRepository } = {}) {
  assertMeetingRepository(meetingRepository);

  return Object.freeze({
    async listMeetingHistory() {
      const meetings = await meetingRepository.listMeetings();
      const items = await Promise.all(
        [...meetings].map(async (meeting) => mapMeetingToHistoryListItem({
          meeting,
          segments: await meetingRepository.listMeetingSegments(meeting.id)
        }))
      );

      return items.sort(compareMeetingHistoryItems);
    },

    async getMeetingDetail(meetingId) {
      const normalizedMeetingId = validateRequiredString(meetingId, 'meetingId');
      const meeting = await meetingRepository.getMeeting(normalizedMeetingId);
      if (!meeting) {
        return null;
      }

      return mapMeetingToDetailDTO({
        meeting,
        segments: await meetingRepository.listMeetingSegments(normalizedMeetingId),
        audioArtifacts: await audioArtifactsForMeeting(sessionRepository, normalizedMeetingId)
      });
    }
  });
}

async function audioArtifactsForMeeting(sessionRepository, meetingId) {
  if (!sessionRepository || typeof sessionRepository.listSessionRecords !== 'function') {
    return {};
  }
  const records = await sessionRepository.listSessionRecords();
  const record = [...records]
    .filter((sessionRecord) => sessionRecord?.meetingId === meetingId && sessionRecord.audioArtifacts)
    .sort((left, right) => timestampValue(left.startedAt) - timestampValue(right.startedAt))[0];
  return record?.audioArtifacts || {};
}

function compareMeetingHistoryItems(left, right) {
  return timestampValue(right.startedAt ?? right.endedAt) - timestampValue(left.startedAt ?? left.endedAt) ||
    String(right.id).localeCompare(String(left.id));
}

function timestampValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function assertMeetingRepository(meetingRepository) {
  if (!meetingRepository) {
    throw new TypeError('meetingRepository is required.');
  }

  for (const method of ['listMeetings', 'getMeeting', 'listMeetingSegments']) {
    if (typeof meetingRepository[method] !== 'function') {
      throw new TypeError(`meetingRepository.${method} must be a function.`);
    }
  }
}

function validateRequiredString(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    const error = new TypeError(`${name} must be a non-empty string.`);
    error.code = 'invalid_request';
    throw error;
  }

  return value;
}
