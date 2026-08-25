import {
  mapSessionRecordDetailToDTO,
  mapSessionRecordToHistoryListItem
} from '../readModels/sessionReadModels.js';

export const SESSION_READ_REPOSITORY_METHODS = Object.freeze(['listSessionHistory', 'getSessionDetail']);

export function createSessionReadRepository({ sessionRepository, meetingRepository } = {}) {
  if (!sessionRepository) {
    throw new Error('sessionRepository is required.');
  }

  return {
    listSessionHistory() {
      const records = sessionRepository.listSessionRecords();

      return mapMaybePromise(records, mapHistoryRecords);
    },

    getSessionDetail(sessionId) {
      const detail = sessionRepository.getSessionRecord(sessionId);

      return mapMaybePromise(detail, materializeSessionDetail);
    }
  };

  function materializeSessionDetail(detail) {
    if (!detail) {
      return null;
    }

    return mapMaybePromise(detailWithMeetingCheckpointTranscript(detail), mapSessionDetail);
  }

  function detailWithMeetingCheckpointTranscript(detail) {
    const meetingId = detail?.sessionRecord?.meetingId;
    if (!meetingRepository || !meetingId || typeof meetingRepository.listMeetingSegments !== 'function') {
      return detail;
    }

    return mapMaybePromise(listMeetingSegmentsOrFallback(meetingId), (segments) => {
      const checkpointItems = transcriptItemsFromMeetingSegments({
        segments,
        sessionId: detail.sessionRecord.id,
        meetingId
      });

      const cues = finalCuesFromMeetingSegments({ segments, sessionId: detail.sessionRecord.id });
      return {
        ...detail,
        ...(checkpointItems.length > 0 ? { transcriptItems: checkpointItems } : {}),
        cues
      };
    });
  }

  function listMeetingSegmentsOrFallback(meetingId) {
    try {
      const segments = meetingRepository.listMeetingSegments(meetingId);
      if (segments && typeof segments.then === 'function') {
        return segments.catch((error) => {
          if (isMeetingNotFoundError(error)) return [];
          throw error;
        });
      }
      return segments;
    } catch (error) {
      if (isMeetingNotFoundError(error)) return [];
      throw error;
    }
  }
}

function mapMaybePromise(value, mapper) {
  if (value && typeof value.then === 'function') {
    return value.then(mapper);
  }

  return mapper(value);
}

function mapHistoryRecords(records) {
  return records
    .filter((record) => (record?.recordKind ?? 'session') === 'session')
    .map(mapSessionRecordToHistoryListItem);
}

function mapSessionDetail(detail) {
  if (!detail) {
    return null;
  }

  return mapSessionRecordDetailToDTO(detail);
}

function transcriptItemsFromMeetingSegments({ segments = [], sessionId, meetingId } = {}) {
  if (!Array.isArray(segments)) {
    return [];
  }

  return segments
    .flatMap((segment) => durableChunksForSegment(segment, meetingId).map((chunk) => ({
      id: chunk.idempotencyKey || `checkpoint:${segment.id}:${chunk.stream}:${chunk.sequence}`,
      sessionId,
      stream: chunk.stream,
      status: 'final',
      text: String(chunk.text).trim(),
      sequence: chunk.sequence,
      startedAt: chunk.timestamp,
      finalizedAt: chunk.timestamp,
      segmentSequence: segment.sequence,
      segmentId: segment.id
    })))
    .sort(compareCheckpointItems)
    .map(({ segmentSequence, segmentId, ...item }) => item);
}

function finalCuesFromMeetingSegments({ segments = [], sessionId } = {}) {
  return segments
    .flatMap((segment) => segment?.checkpoint?.refinedSubtitleStatus === 'completed' && Array.isArray(segment?.checkpoint?.refinedSubtitleCues) && segment.checkpoint.refinedSubtitleCues.length > 0
      ? segment.checkpoint.refinedSubtitleCues
      : (Array.isArray(segment?.checkpoint?.finalCues) ? segment.checkpoint.finalCues : []))
    .filter((cue) => cue?.status === 'final' &&
      typeof cue.sourceText === 'string' && cue.sourceText.trim() &&
      typeof cue.translatedText === 'string' && cue.translatedText.trim())
    .sort((left, right) => left.sequence - right.sequence)
    .map((cue) => ({ ...cue }));
}

function durableChunksForSegment(segment, meetingId) {
  if (!segment || typeof segment.id !== 'string' || !Number.isInteger(segment.sequence)) {
    return [];
  }

  const chunks = segment.checkpoint?.durableChunks;
  if (!Array.isArray(chunks)) {
    return [];
  }

  return chunks.filter((chunk) => validCheckpointChunk(chunk, meetingId, segment.id));
}

function validCheckpointChunk(chunk, meetingId, segmentId) {
  return chunk &&
    chunk.meetingId === meetingId &&
    chunk.segmentId === segmentId &&
    (chunk.stream === 'source' || chunk.stream === 'translation') &&
    Number.isInteger(chunk.sequence) &&
    chunk.sequence >= 0 &&
    typeof chunk.text === 'string' &&
    chunk.text.trim().length > 0 &&
    (typeof chunk.timestamp === 'string' || typeof chunk.timestamp === 'number');
}

function compareCheckpointItems(left, right) {
  return left.segmentSequence - right.segmentSequence ||
    left.sequence - right.sequence ||
    left.id.localeCompare(right.id);
}

function isMeetingNotFoundError(error) {
  return error?.code === 'meeting_not_found' || /^Meeting not found:/.test(error?.message || '');
}
