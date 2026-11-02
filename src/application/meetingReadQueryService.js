import {
  mapMeetingToDetailDTO,
  mapMeetingToHistoryListItem,
  mapMeetingToViewerDTO,
  mapMeetingToViewerMetadataDTO,
  finalCuesFromSegments
} from '../readModels/meetingReadModels.js';
import { audioArtifactDownloadByteLength } from '../infrastructure/sessionAudioArtifacts.js';
import { isMeetingContentExpired, meetingContentExpiredError } from '../lib/meetingRetention.js';
import {
  compareViewerCues,
  decodeViewerCursor,
  encodeViewerCursor,
  normalizeViewerPageSize
} from '../lib/meetingViewerPagination.js';

export function createMeetingReadQueryService({ meetingRepository, sessionRepository, meetingAudioService } = {}) {
  assertMeetingRepository(meetingRepository);

  return Object.freeze({
    async getMeetingViewerMetadata(meetingId) {
      const normalizedMeetingId = validateRequiredString(meetingId, 'meetingId');
      const meeting = await (meetingRepository.getMeetingMetadata || meetingRepository.getMeeting).call(meetingRepository, normalizedMeetingId);
      if (!meeting) return null;
      if (isMeetingContentExpired(meeting)) throw meetingContentExpiredError();
      if (typeof meetingRepository.listMeetingSegmentMetadata !== 'function') {
        throw new TypeError('Meeting repository must provide listMeetingSegmentMetadata.');
      }
      const segments = await meetingRepository.listMeetingSegmentMetadata(normalizedMeetingId, meeting.ownerUserId);
      return mapMeetingToViewerMetadataDTO({ meeting, segments, recordingState: viewerRecordingState(meeting, segments) });
    },
    async listMeetingHistory({ actorUserId = null, isSystemAdmin = false, now = Date.now() } = {}) {
      const meetings = await meetingRepository.listMeetings({ includeAll: isSystemAdmin });
      const visibleMeetings = isSystemAdmin
        ? meetings
        : meetings.filter((meeting) => !isMeetingContentExpired(meeting, now));
      const items = await Promise.all(
        [...visibleMeetings].map(async (meeting) => {
          const expired = isMeetingContentExpired(meeting, now);
          return {
            ...mapMeetingToHistoryListItem({
              meeting,
              segments: expired ? [] : await meetingRepository.listMeetingSegments(meeting.id, meeting.ownerUserId)
            }),
            ownerUserId: meeting.ownerUserId || null,
            isPendingDelete: Boolean(isSystemAdmin && expired),
            canDelete: Boolean(isSystemAdmin || !meeting.ownerUserId || (actorUserId && meeting.ownerUserId === actorUserId))
          };
        })
      );

      return items.sort(compareMeetingHistoryItems);
    },

    async getMeetingDetail(meetingId, { actorUserId = null, isSystemAdmin = false, now = Date.now() } = {}) {
      const normalizedMeetingId = validateRequiredString(meetingId, 'meetingId');
      const meeting = await meetingRepository.getMeeting(normalizedMeetingId);
      if (!meeting) {
        return null;
      }
      if (isMeetingContentExpired(meeting, now)) {
        if (!isSystemAdmin) throw meetingContentExpiredError();
        const detail = mapMeetingToDetailDTO({ meeting, segments: [], audioArtifacts: {}, cloudAudioArtifacts: [] });
        return {
          ...detail,
          meeting: {
            ...detail.meeting,
            ownerUserId: meeting.ownerUserId || null,
            isPendingDelete: true,
            canDelete: true
          }
        };
      }

      const segments = await meetingRepository.listMeetingSegments(normalizedMeetingId, meeting.ownerUserId);
      const detail = mapMeetingToDetailDTO({
        meeting,
        segments: segments.map(({ id, meetingId: segmentMeetingId, sessionId, sequence, status, startedAt, endedAt, liveSessionId }) => ({
          id, meetingId: segmentMeetingId, sessionId, sequence, status, startedAt, endedAt, liveSessionId
        })),
        audioArtifacts: {},
        cloudAudioArtifacts: []
      });
      return {
        ...detail,
        meeting: {
          ...detail.meeting,
          ownerUserId: meeting.ownerUserId || null,
          isPendingDelete: false,
          canDelete: Boolean(isSystemAdmin || !meeting.ownerUserId || (actorUserId && meeting.ownerUserId === actorUserId))
        }
      };
    },

    async getMeetingViewerPage(meetingId, options = {}) {
      const normalizedMeetingId = validateRequiredString(meetingId, 'meetingId');
      const limit = normalizeViewerPageSize(options.limit);
      const before = decodeViewerCursor(options.before);
      const meeting = await meetingRepository.getMeeting(normalizedMeetingId);
      if (!meeting) return null;
      if (isMeetingContentExpired(meeting)) throw meetingContentExpiredError();
      const segments = await meetingRepository.listMeetingSegments(normalizedMeetingId, meeting.ownerUserId);
      const recordingState = viewerRecordingState(meeting, segments);
      return mapMeetingToViewerDTO({ meeting, recordingState, cues: [], hasMore: false, limit, nextCursor: null });

      if (typeof meetingRepository.getMeetingViewerPage === 'function') {
        const page = await meetingRepository.getMeetingViewerPage(normalizedMeetingId, { before, limit });
        return mapMeetingToViewerDTO({ meeting, recordingState, limit, ...page });
      }

      const sequenceBySegmentId = new Map(segments.map((segment) => [segment.id, segment.sequence]));
      const cues = finalCuesFromSegments(segments)
        .map((cue) => ({ ...cue, segmentSequence: sequenceBySegmentId.get(cue.segmentId) ?? 0 }))
        .sort(compareViewerCues);
      const end = before ? cues.findIndex((cue) => compareViewerCues(cue, before) >= 0) : cues.length;
      const eligible = cues.slice(0, end < 0 ? cues.length : end);
      const page = eligible.slice(Math.max(0, eligible.length - limit - 1));
      const hasMore = page.length > limit;
      const visibleCues = page.slice(hasMore ? 1 : 0);
      const oldest = visibleCues[0];
      return mapMeetingToViewerDTO({
        meeting,
        recordingState,
        cues: visibleCues,
        hasMore,
        limit,
        nextCursor: hasMore && oldest ? encodeViewerCursor(oldest) : null
      });
    }
  });
}

export function viewerRecordingState(meeting, segments = []) {
  if (['completed', 'failed'].includes(meeting?.status)) return 'ended';
  if (meeting?.status === 'interrupted') return 'recovering';
  if (segments.some((segment) => segment?.status === 'active')) return 'active';
  if (meeting?.status === 'active') return 'paused';
  return 'waiting';
}

async function listCloudAudioArtifacts(service, meetingId) {
  try {
    return await service.listMeetingArtifacts(meetingId);
  } catch (error) {
    // Anonymous shared Viewer requests intentionally have no owner identity;
    // their DTO excludes audio metadata.
    if (error?.code === 'auth_required') return [];
    throw error;
  }
}

function attachSegmentSequence(artifacts, segments) {
  const sequenceById = new Map(segments.map((segment) => [segment.id, segment.sequence]));
  return artifacts.map((artifact) => ({
    ...artifact,
    segmentSequence: sequenceById.get(artifact.segmentId) ?? null
  }));
}

async function audioArtifactsForMeeting(sessionRepository, meetingId, segments = []) {
  if (!sessionRepository || typeof sessionRepository.listSessionRecords !== 'function') {
    return {};
  }
  const records = await sessionRepository.listSessionRecords();
  const orderByLiveSessionId = new Map(segments.map((segment) => [segment.liveSessionId, segment.sequence]));
  const meetingRecords = records
    .filter((sessionRecord) => sessionRecord?.meetingId === meetingId && sessionRecord.audioArtifacts)
    .sort((left, right) => (
      (orderByLiveSessionId.get(left.liveSessionId) ?? Number.MAX_SAFE_INTEGER) -
        (orderByLiveSessionId.get(right.liveSessionId) ?? Number.MAX_SAFE_INTEGER) ||
      timestampValue(left.startedAt) - timestampValue(right.startedAt) ||
      String(left.id).localeCompare(String(right.id))
    ));

  return Object.fromEntries(['input', 'translation'].flatMap((kind) => {
    const artifacts = meetingRecords.map((record) => record.audioArtifacts?.[kind]).filter(Boolean);
    if (artifacts.length === 0) return [];
    const totalDataBytes = artifacts.reduce((total, artifact) => (
      total + Math.max(0, audioArtifactDownloadByteLength(artifact) - 44)
    ), 0);
    const first = artifacts[0];
    return [[kind, {
      ...first,
      storageMode: 'meeting-composed',
      byteLength: 44 + totalDataBytes,
      fileName: `live-translate-meeting-${meetingId}-${kind}.wav`
    }]];
  }));
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
