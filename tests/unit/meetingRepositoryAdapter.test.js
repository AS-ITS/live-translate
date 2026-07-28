import assert from 'node:assert/strict';
import test from 'node:test';
import { Meeting, MeetingSegment } from '../../src/domain/meeting/index.js';
import { MEETING_REPOSITORY_METHODS } from '../../src/domain/meeting/meetingRepository.js';
import { createMemoryMeetingRepository } from '../../src/infrastructure/meetingRepositoryAdapter.js';

test('memory repository exposes the MeetingRepository interface', () => {
  const repository = createMemoryMeetingRepository();

  assert.equal(Object.isFrozen(repository), true);
  assert.deepEqual(Object.keys(repository), MEETING_REPOSITORY_METHODS);
});

test('creates, gets, updates, and lists meetings with defensive copies', () => {
  const repository = createMemoryMeetingRepository();
  const created = repository.createMeeting({ id: 'meeting-1', createdAt: 1000 });
  const fetched = repository.getMeeting('meeting-1');
  const updated = repository.updateMeeting(created.activate(1100));

  assert.equal(created instanceof Meeting, true);
  assert.equal(fetched instanceof Meeting, true);
  assert.notStrictEqual(fetched, created);
  assert.equal(updated.status, 'active');
  assert.deepEqual(repository.listMeetings().map((meeting) => meeting.id), ['meeting-1']);
  assert.equal(repository.getMeeting('missing'), null);
});

test('meeting duplicate and missing update behavior is deterministic', () => {
  const repository = createMemoryMeetingRepository();

  repository.createMeeting({ id: 'meeting-1', createdAt: 1000 });

  assert.throws(() => repository.createMeeting({ id: 'meeting-1', createdAt: 1000 }), /already exists/);
  assert.equal(repository.updateMeeting({ id: 'missing-meeting', createdAt: 1000 }), null);
});

test('creates ordered meeting segments and enforces meeting ownership', () => {
  const repository = createMemoryMeetingRepository();
  repository.createMeeting({ id: 'meeting-1', createdAt: 1000 });
  repository.createMeeting({ id: 'meeting-2', createdAt: 1000 });

  const second = repository.createMeetingSegment({
    id: 'segment-2',
    meetingId: 'meeting-1',
    sequence: 1,
    createdAt: 1100
  });
  const first = repository.createMeetingSegment({
    id: 'segment-1',
    meetingId: 'meeting-1',
    sequence: 0,
    createdAt: 1000
  });
  repository.createMeetingSegment({ id: 'segment-3', meetingId: 'meeting-2', sequence: 0, createdAt: 1000 });

  assert.equal(second instanceof MeetingSegment, true);
  assert.deepEqual(
    repository.listMeetingSegments('meeting-1').map((segment) => segment.id),
    ['segment-1', 'segment-2']
  );
  assert.equal(repository.getMeetingSegment('segment-1').id, first.id);
  assert.deepEqual(
    repository.listMeetingSegments('meeting-2').map((segment) => segment.id),
    ['segment-3']
  );
});

test('segment update persists independent lifecycle state', () => {
  const repository = createMemoryMeetingRepository();
  repository.createMeeting({ id: 'meeting-1', createdAt: 1000 });
  const segment = repository
    .createMeetingSegment({ id: 'segment-1', meetingId: 'meeting-1', sequence: 0, createdAt: 1000 })
    .activate(1100)
    .withLiveSession('session-1')
    .withCheckpoint({ offsetMs: 1000 }, 1150);

  const updated = repository.updateMeetingSegment(
    segment.interrupt({ endedAt: 1200, checkpoint: { offsetMs: 2000 }, errorInfo: { reason: 'network_error' } })
  );

  assert.equal(updated.status, 'interrupted');
  assert.equal(updated.liveSessionId, 'session-1');
  assert.deepEqual(repository.getMeetingSegment('segment-1').checkpoint, { offsetMs: 2000 });
  assert.deepEqual(repository.listMeetingSegments('meeting-1')[0].errorInfo, { reason: 'network_error' });
});

test('segment duplicate, missing, and sequence conflict behavior is deterministic', () => {
  const repository = createMemoryMeetingRepository();
  repository.createMeeting({ id: 'meeting-1', createdAt: 1000 });
  repository.createMeetingSegment({ id: 'segment-1', meetingId: 'meeting-1', sequence: 0, createdAt: 1000 });

  assert.throws(
    () => repository.createMeetingSegment({ id: 'segment-2', meetingId: 'missing', sequence: 0, createdAt: 1000 }),
    /Meeting not found/
  );
  assert.throws(
    () => repository.createMeetingSegment({ id: 'segment-1', meetingId: 'meeting-1', sequence: 1, createdAt: 1000 }),
    /already exists/
  );
  assert.throws(
    () => repository.createMeetingSegment({ id: 'segment-2', meetingId: 'meeting-1', sequence: 0, createdAt: 1000 }),
    /sequence already exists/
  );
  assert.equal(repository.getMeetingSegment('missing-segment'), null);
  assert.equal(
    repository.updateMeetingSegment({ id: 'missing-segment', meetingId: 'meeting-1', sequence: 1, createdAt: 1000 }),
    null
  );
});
