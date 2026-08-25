import assert from 'node:assert/strict';
import test from 'node:test';
import { createMeetingRepository, MEETING_REPOSITORY_METHODS } from '../../src/domain/meeting/meetingRepository.js';

const EXPECTED_METHODS = [
  'createMeeting',
  'getMeeting',
  'updateMeeting',
  'deleteMeeting',
  'listMeetings',
  'createMeetingSegment',
  'getMeetingSegment',
  'listMeetingSegments',
  'updateMeetingSegment'
];

test('exports meeting repository factory', () => {
  assert.equal(typeof createMeetingRepository, 'function');
});

test('repository exposes exactly the required meeting repository methods', () => {
  const repository = createMeetingRepository();

  assert.deepEqual(MEETING_REPOSITORY_METHODS, EXPECTED_METHODS);
  assert.deepEqual(Object.keys(repository), EXPECTED_METHODS);

  for (const method of EXPECTED_METHODS) {
    assert.equal(typeof repository[method], 'function');
  }
});

test('every repository method throws not implemented error', () => {
  const repository = createMeetingRepository();

  for (const method of EXPECTED_METHODS) {
    assert.throws(() => repository[method](), new RegExp(`MeetingRepository\\.${method} is not implemented\\.`));
  }
});

test('repository method list and object shape are immutable', () => {
  const repository = createMeetingRepository();

  assert.equal(Object.isFrozen(MEETING_REPOSITORY_METHODS), true);
  assert.equal(Object.isFrozen(repository), true);
  assert.throws(() => {
    MEETING_REPOSITORY_METHODS.push('extraMethod');
  }, TypeError);
  assert.throws(() => {
    repository.extraMethod = () => null;
  }, TypeError);
});
