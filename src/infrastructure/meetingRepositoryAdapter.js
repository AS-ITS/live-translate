import { Meeting, MeetingSegment } from '../domain/meeting/index.js';
import { assertCheckpointPreservedOnGenericUpdate } from '../lib/checkpointOperation.js';
import { MEETING_REPOSITORY_METHODS } from '../domain/meeting/meetingRepository.js';

export function createMemoryMeetingRepository() {
  const meetings = new Map();
  const segments = new Map();

  const repository = {
    createMeeting(meeting) {
      const entity = new Meeting(meeting);
      if (meetings.has(entity.id)) {
        throw new Error(`Meeting already exists: ${entity.id}`);
      }

      meetings.set(entity.id, clonePlain(entity));
      segments.set(entity.id, []);
      return new Meeting(entity);
    },

    getMeeting(meetingId) {
      const meeting = meetings.get(meetingId);
      return meeting ? new Meeting(meeting) : null;
    },

    updateMeeting(meeting) {
      const entity = new Meeting(meeting);
      const stored = meetings.get(entity.id);
      if (!stored) return null;

      meetings.set(entity.id, clonePlain(entity));
      return new Meeting(entity);
    },

    deleteMeeting(meetingId) {
      const meeting = meetings.get(meetingId);
      if (!meeting) return null;

      meetings.delete(meetingId);
      segments.delete(meetingId);
      return new Meeting(meeting);
    },

    listMeetings() {
      return Array.from(meetings.values(), (meeting) => new Meeting(meeting));
    },

    createMeetingSegment(segment) {
      const entity = new MeetingSegment(segment);
      requireMeeting(entity.meetingId);
      const meetingSegments = segments.get(entity.meetingId) || [];

      if (findSegmentById(entity.id)) {
        throw new Error(`MeetingSegment already exists: ${entity.id}`);
      }

      if (meetingSegments.some((stored) => stored.sequence === entity.sequence)) {
        throw new Error(`MeetingSegment sequence already exists for meeting ${entity.meetingId}: ${entity.sequence}`);
      }

      segments.set(entity.meetingId, [...meetingSegments, clonePlain(entity)]);
      return new MeetingSegment(entity);
    },

    getMeetingSegment(segmentId) {
      const result = findSegmentById(segmentId);
      return result ? new MeetingSegment(result.segment) : null;
    },

    listMeetingSegments(meetingId) {
      requireMeeting(meetingId);
      return (segments.get(meetingId) || []).map((segment) => new MeetingSegment(segment)).sort(compareSegments);
    },
    listMeetingSegmentMetadata(meetingId) {
      requireMeeting(meetingId);
      return (segments.get(meetingId) || []).map(segmentMetadata).sort(compareSegments);
    },

    updateMeetingSegment(segment) {
      const entity = new MeetingSegment(segment);
      requireMeeting(entity.meetingId);
      const existing = findSegmentById(entity.id);
      if (existing && existing.meetingId !== entity.meetingId) {
        throw new Error(`MeetingSegment ${entity.id} cannot change meetingId`);
      }
      if (existing) assertCheckpointPreservedOnGenericUpdate(existing.segment.checkpoint, entity.checkpoint);
      const meetingSegments = segments.get(entity.meetingId) || [];
      const index = meetingSegments.findIndex((stored) => stored.id === entity.id);

      if (index === -1) return null;

      if (meetingSegments.some((stored) => stored.id !== entity.id && stored.sequence === entity.sequence)) {
        throw new Error(`MeetingSegment sequence already exists for meeting ${entity.meetingId}: ${entity.sequence}`);
      }

      const nextSegments = [...meetingSegments];
      nextSegments[index] = clonePlain(entity);
      segments.set(entity.meetingId, nextSegments);
      return new MeetingSegment(entity);
    },

    mutateMeetingSegment(segmentId, operation) {
      const found = findSegmentById(segmentId);
      if (!found) return null;
      const current = new MeetingSegment(found.segment);
      const next = operation(current);
      if (next === current) return current;
      const entity = new MeetingSegment(next);
      if (entity.id !== current.id || entity.meetingId !== current.meetingId) {
        throw new Error('MeetingSegment identity cannot change during checkpoint mutation.');
      }
      const meetingSegments = segments.get(entity.meetingId);
      const index = meetingSegments.findIndex((stored) => stored.id === entity.id);
      const nextSegments = [...meetingSegments];
      nextSegments[index] = clonePlain(entity);
      segments.set(entity.meetingId, nextSegments);
      return new MeetingSegment(entity);
    }
  };

  const exposed = Object.fromEntries(MEETING_REPOSITORY_METHODS.map((method) => [method, repository[method]]));
  Object.defineProperty(exposed, 'mutateMeetingSegment', { value: repository.mutateMeetingSegment });
  Object.defineProperty(exposed, 'listMeetingSegmentMetadata', { value: repository.listMeetingSegmentMetadata });
  return Object.freeze(exposed);

  function requireMeeting(meetingId) {
    if (!meetings.has(meetingId)) {
      throw new Error(`Meeting not found: ${meetingId}`);
    }
  }

  function findSegmentById(segmentId) {
    for (const [meetingId, meetingSegments] of segments.entries()) {
      const segment = meetingSegments.find((stored) => stored.id === segmentId);
      if (segment) return { meetingId, segment };
    }

    return null;
  }
}

function compareSegments(left, right) {
  return left.sequence - right.sequence || compareTimestamps(left.createdAt, right.createdAt) || left.id.localeCompare(right.id);
}

function segmentMetadata(segment) {
  const { id, meetingId, sessionId, sequence, status, startedAt, endedAt, createdAt } = segment;
  return { id, meetingId, sessionId, sequence, status, startedAt, endedAt, createdAt };
}

function compareTimestamps(left, right) {
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  return String(left).localeCompare(String(right));
}

function clonePlain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}
