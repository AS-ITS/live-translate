import { dirname } from 'node:path';
import { Meeting, MeetingSegment } from '../domain/meeting/index.js';
import { MEETING_REPOSITORY_METHODS } from '../domain/meeting/meetingRepository.js';

const INITIAL_STORAGE = Object.freeze({
  schemaVersion: 1,
  meetings: Object.freeze([]),
  segments: Object.freeze({})
});

export function createFileMeetingRepository({ filePath, fileSystem } = {}) {
  assertFilePath(filePath);
  assertFileSystem(fileSystem);

  let mutationQueue = Promise.resolve();

  const repository = {
    async createMeeting(meeting) {
      return mutate(async (storage) => {
        const entity = new Meeting(meeting);
        if (storage.meetings.some((stored) => stored.id === entity.id)) {
          throw new Error(`Meeting already exists: ${entity.id}`);
        }

        storage.meetings.push(clonePlain(entity));
        storage.segments[entity.id] = [];
        return new Meeting(entity);
      });
    },

    async getMeeting(meetingId) {
      const storage = await readStorage({ filePath, fileSystem });
      const meeting = storage.meetings.find((stored) => stored.id === meetingId);
      return meeting ? new Meeting(meeting) : null;
    },

    async updateMeeting(meeting) {
      return mutate(async (storage) => {
        const entity = new Meeting(meeting);
        const index = storage.meetings.findIndex((stored) => stored.id === entity.id);
        if (index === -1) return null;

        storage.meetings[index] = clonePlain(entity);
        return new Meeting(entity);
      });
    },

    async listMeetings() {
      const storage = await readStorage({ filePath, fileSystem });
      return storage.meetings.map((meeting) => new Meeting(meeting));
    },

    async createMeetingSegment(segment) {
      return mutate(async (storage) => {
        const entity = new MeetingSegment(segment);
        requireMeeting(storage, entity.meetingId);
        if (findSegmentById(storage, entity.id)) {
          throw new Error(`MeetingSegment already exists: ${entity.id}`);
        }

        const meetingSegments = storage.segments[entity.meetingId] || [];
        if (meetingSegments.some((stored) => stored.sequence === entity.sequence)) {
          throw new Error(`MeetingSegment sequence already exists for meeting ${entity.meetingId}: ${entity.sequence}`);
        }

        storage.segments[entity.meetingId] = [...meetingSegments, clonePlain(entity)];
        return new MeetingSegment(entity);
      });
    },

    async getMeetingSegment(segmentId) {
      const storage = await readStorage({ filePath, fileSystem });
      const result = findSegmentById(storage, segmentId);
      return result ? new MeetingSegment(result.segment) : null;
    },

    async listMeetingSegments(meetingId) {
      const storage = await readStorage({ filePath, fileSystem });
      requireMeeting(storage, meetingId);
      return (storage.segments[meetingId] || []).map((segment) => new MeetingSegment(segment)).sort(compareSegments);
    },

    async updateMeetingSegment(segment) {
      return mutate(async (storage) => {
        const entity = new MeetingSegment(segment);
        requireMeeting(storage, entity.meetingId);
        const existing = findSegmentById(storage, entity.id);
        if (existing && existing.meetingId !== entity.meetingId) {
          throw new Error(`MeetingSegment ${entity.id} cannot change meetingId`);
        }
        const meetingSegments = storage.segments[entity.meetingId] || [];
        const index = meetingSegments.findIndex((stored) => stored.id === entity.id);

        if (index === -1) return null;

        if (meetingSegments.some((stored) => stored.id !== entity.id && stored.sequence === entity.sequence)) {
          throw new Error(`MeetingSegment sequence already exists for meeting ${entity.meetingId}: ${entity.sequence}`);
        }

        const nextSegments = [...meetingSegments];
        nextSegments[index] = clonePlain(entity);
        storage.segments[entity.meetingId] = nextSegments;
        return new MeetingSegment(entity);
      });
    }
  };

  return Object.freeze(Object.fromEntries(MEETING_REPOSITORY_METHODS.map((method) => [method, repository[method]])));

  function mutate(operation) {
    const nextMutation = mutationQueue.then(async () => {
      const storage = await readStorage({ filePath, fileSystem });
      const result = await operation(storage);
      await writeStorage({ filePath, fileSystem, storage });
      return result;
    });

    mutationQueue = nextMutation.catch(() => {});
    return nextMutation;
  }
}

async function readStorage({ filePath, fileSystem }) {
  let content;
  try {
    content = await fileSystem.readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return clonePlain(INITIAL_STORAGE);
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    const error = new TypeError('Meeting repository JSON is invalid.');
    error.code = 'invalid_meeting_repository_storage';
    throw error;
  }

  return normalizeStorage(parsed);
}

async function writeStorage({ filePath, fileSystem, storage }) {
  const normalized = normalizeStorage(storage);
  const directory = dirname(filePath);
  await fileSystem.mkdir(directory, { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  await fileSystem.writeFile(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  await fileSystem.rename(temporaryPath, filePath);
}

function normalizeStorage(value) {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.meetings) || !isRecord(value.segments)) {
    const error = new TypeError('Meeting repository storage shape is invalid.');
    error.code = 'invalid_meeting_repository_storage';
    throw error;
  }

  const meetings = value.meetings.map((meeting, index) => {
    try {
      return clonePlain(new Meeting(meeting));
    } catch (cause) {
      const error = new TypeError(`Meeting repository meeting ${index} is invalid.`);
      error.code = 'invalid_meeting_repository_storage';
      error.cause = cause;
      throw error;
    }
  });

  const segments = {};
  for (const [meetingId, meetingSegments] of Object.entries(value.segments)) {
    if (!Array.isArray(meetingSegments)) {
      const error = new TypeError(`Meeting repository segments.${meetingId} must be an array.`);
      error.code = 'invalid_meeting_repository_storage';
      throw error;
    }

    segments[meetingId] = meetingSegments.map((segment, index) => {
      try {
        const entity = new MeetingSegment(segment);
        if (entity.meetingId !== meetingId) {
          throw new Error(`segment meetingId ${entity.meetingId} does not match storage bucket ${meetingId}`);
        }
        return clonePlain(entity);
      } catch (cause) {
        const error = new TypeError(`Meeting repository segment ${meetingId}.${index} is invalid.`);
        error.code = 'invalid_meeting_repository_storage';
        error.cause = cause;
        throw error;
      }
    });
  }

  return { schemaVersion: 1, meetings, segments };
}

function requireMeeting(storage, meetingId) {
  if (!storage.meetings.some((meeting) => meeting.id === meetingId)) {
    throw new Error(`Meeting not found: ${meetingId}`);
  }
}

function findSegmentById(storage, segmentId) {
  for (const [meetingId, meetingSegments] of Object.entries(storage.segments)) {
    const segment = meetingSegments.find((stored) => stored.id === segmentId);
    if (segment) return { meetingId, segment };
  }

  return null;
}

function compareSegments(left, right) {
  return left.sequence - right.sequence || compareTimestamps(left.createdAt, right.createdAt) || left.id.localeCompare(right.id);
}

function compareTimestamps(left, right) {
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  return String(left).localeCompare(String(right));
}

function assertFilePath(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError('MEETING_RECORDS_FILE must be a non-empty string when provided.');
  }
}

function assertFileSystem(value) {
  for (const method of ['readFile', 'mkdir', 'writeFile', 'rename']) {
    if (!value || typeof value[method] !== 'function') {
      throw new TypeError(`fileSystem.${method} must be a function.`);
    }
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clonePlain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}
