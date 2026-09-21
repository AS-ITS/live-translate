import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MEETING_SEGMENT_STATUSES,
  MEETING_STATUSES,
  Meeting,
  MeetingSegment,
  isTerminalMeetingSegmentStatus,
  isTerminalMeetingStatus
} from '../../src/domain/meeting/index.js';

test('Meeting constructs an immutable created aggregate', () => {
  const meeting = new Meeting({
    id: 'meeting-1',
    createdAt: 1000
  });

  assert.equal(meeting.id, 'meeting-1');
  assert.equal(meeting.status, 'created');
  assert.equal(meeting.startedAt, null);
  assert.equal(meeting.endedAt, null);
  assert.equal(meeting.failureInfo, null);
  assert.equal(meeting.updatedAt, 1000);
  assert.deepEqual(MEETING_STATUSES, ['created', 'active', 'completed', 'interrupted', 'failed']);
  assert.equal(Object.isFrozen(meeting), true);
});

test('Meeting preserves an immutable glossary snapshot across lifecycle transitions', () => {
  const entries = [{ source: 'Acme', target: '艾克米', replacementAliases: ['ACME'] }];
  const meeting = new Meeting({ id: 'meeting-1', createdAt: 1000, glossaryEntries: entries });
  entries[0].target = 'changed';

  assert.deepEqual(meeting.glossaryEntries, [{ source: 'Acme', target: '艾克米', replacementAliases: ['ACME'] }]);
  assert.deepEqual(meeting.activate(1100).glossaryEntries, meeting.glossaryEntries);
});

test('Meeting preserves isolated private glossary entries and rejects duplicate sources', () => {
  const meeting = new Meeting({
    id: 'meeting-1',
    createdAt: 1000,
    privateGlossaryEntries: [{ source: '專案代號', translations: { en: 'Project Codename' }, replacementAliases: { en: ['代號'] } }]
  });
  assert.deepEqual(meeting.privateGlossaryEntries, [{ source: '專案代號', translations: { en: 'Project Codename' }, replacementAliases: { en: ['代號'] } }]);
  assert.deepEqual(meeting.activate(1100).privateGlossaryEntries, meeting.privateGlossaryEntries);
  assert.throws(() => new Meeting({
    id: 'meeting-2', createdAt: 1000,
    privateGlossaryEntries: [{ source: 'same', translations: { en: 'one' } }, { source: 'same', translations: { en: 'two' } }]
  }), /duplicated/);
});

test('Meeting supports legal lifecycle transitions', () => {
  const created = new Meeting({ id: 'meeting-1', createdAt: 1000 });
  const active = created.activate(1100);
  const interrupted = active.interrupt(1200);
  const resumed = interrupted.activate(1300);
  const completed = resumed.complete(1400);
  const completedBeforeStart = created.complete(1500);
  const failed = created.activate(1100).fail({ reason: 'storage_error', nested: { code: 'x' } }, 1500);

  assert.equal(active.status, 'active');
  assert.equal(active.startedAt, 1100);
  assert.equal(interrupted.status, 'interrupted');
  assert.equal(interrupted.endedAt, 1200);
  assert.equal(resumed.status, 'active');
  assert.equal(resumed.endedAt, null);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.endedAt, 1400);
  assert.equal(completedBeforeStart.status, 'completed');
  assert.equal(completedBeforeStart.startedAt, 1000);
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.failureInfo, { reason: 'storage_error', nested: { code: 'x' } });
  assert.throws(() => {
    failed.failureInfo.nested.code = 'mutated';
  }, TypeError);
});

test('Meeting normalizes legacy empty private glossary aliases', () => {
  const meeting = new Meeting({
    id: 'meeting-1',
    createdAt: 1000,
    privateGlossaryEntries: [{
      source: '專案代號',
      translations: { en: 'Project Codename' },
      replacementAliases: []
    }]
  });

  assert.deepEqual(meeting.privateGlossaryEntries, [{
    source: '專案代號',
    translations: { en: 'Project Codename' },
    replacementAliases: {}
  }]);
});

test('Meeting rejects invalid data and illegal transitions', () => {
  const created = new Meeting({ id: 'meeting-1', createdAt: 1000 });
  const active = created.activate(1100);
  const completed = active.complete(1200);

  assert.throws(() => new Meeting(), /id/);
  assert.throws(() => new Meeting({ id: 'meeting-1', createdAt: 1000, status: 'unknown' }), /not supported/);
  assert.throws(() => new Meeting({ id: 'meeting-1', createdAt: 1000, status: 'created', startedAt: 1000 }), /created meeting/);
  assert.throws(() => completed.fail({ reason: 'later' }, 1300), /transition/);
});

test('MeetingSegment constructs an immutable created segment', () => {
  const segment = new MeetingSegment({
    id: 'segment-1',
    meetingId: 'meeting-1',
    sequence: 0,
    createdAt: 1000
  });

  assert.equal(segment.id, 'segment-1');
  assert.equal(segment.meetingId, 'meeting-1');
  assert.equal(segment.sequence, 0);
  assert.equal(segment.status, 'created');
  assert.equal(segment.liveSessionId, null);
  assert.equal(segment.checkpoint, null);
  assert.deepEqual(MEETING_SEGMENT_STATUSES, ['created', 'active', 'completed', 'interrupted', 'failed']);
  assert.equal(Object.isFrozen(segment), true);
});

test('MeetingSegment tracks live session, checkpoint, and lifecycle independently', () => {
  const checkpoint = { offsetMs: 3000, transcriptItemId: 'source-3' };
  const active = new MeetingSegment({
    id: 'segment-1',
    meetingId: 'meeting-1',
    sequence: 0,
    createdAt: 1000
  })
    .activate(1100)
    .withLiveSession('session-1')
    .withCheckpoint(checkpoint, 1150);

  checkpoint.offsetMs = 9999;

  const interrupted = active.interrupt({
    endedAt: 1200,
    errorInfo: { reason: 'network_error' }
  });
  const resumed = interrupted.activate(1300);
  const completed = resumed.complete({
    endedAt: 1400,
    checkpoint: { offsetMs: 5000 }
  });
  const completedBeforeStart = new MeetingSegment({
    id: 'segment-3',
    meetingId: 'meeting-1',
    sequence: 2,
    createdAt: 1000
  }).complete({ endedAt: 1500 });
  const failed = new MeetingSegment({
    id: 'segment-2',
    meetingId: 'meeting-1',
    sequence: 1,
    createdAt: 1000
  })
    .activate(1100)
    .fail({ endedAt: 1250, errorInfo: { reason: 'provider_error' } });

  assert.equal(active.liveSessionId, 'session-1');
  assert.deepEqual(active.checkpoint, { offsetMs: 3000, transcriptItemId: 'source-3' });
  assert.equal(interrupted.status, 'interrupted');
  assert.deepEqual(interrupted.errorInfo, { reason: 'network_error' });
  assert.equal(resumed.status, 'active');
  assert.equal(resumed.endedAt, null);
  assert.equal(resumed.errorInfo, null);
  assert.equal(completed.status, 'completed');
  assert.deepEqual(completed.checkpoint, { offsetMs: 5000 });
  assert.equal(completedBeforeStart.status, 'completed');
  assert.equal(completedBeforeStart.startedAt, 1000);
  assert.equal(failed.status, 'failed');
});

test('MeetingSegment rejects invalid data and illegal transitions', () => {
  const created = new MeetingSegment({
    id: 'segment-1',
    meetingId: 'meeting-1',
    sequence: 0,
    createdAt: 1000
  });
  const active = created.activate(1100);
  const completed = active.complete({ endedAt: 1200 });

  assert.throws(() => new MeetingSegment(), /id/);
  assert.throws(
    () => new MeetingSegment({ id: 'segment-1', meetingId: 'meeting-1', sequence: -1, createdAt: 1000 }),
    /sequence/
  );
  assert.throws(() => active.fail({ endedAt: 1200 }), /errorInfo/);
  assert.throws(() => completed.withCheckpoint({ offsetMs: 1 }, 1300), /checkpoint cannot be changed/);
});

test('terminal meeting status helpers expose persistence lifecycle decisions', () => {
  assert.equal(isTerminalMeetingStatus('created'), false);
  assert.equal(isTerminalMeetingStatus('active'), false);
  assert.equal(isTerminalMeetingStatus('interrupted'), false);
  assert.equal(isTerminalMeetingStatus('completed'), true);
  assert.equal(isTerminalMeetingStatus('failed'), true);

  assert.equal(isTerminalMeetingSegmentStatus('created'), false);
  assert.equal(isTerminalMeetingSegmentStatus('active'), false);
  assert.equal(isTerminalMeetingSegmentStatus('interrupted'), false);
  assert.equal(isTerminalMeetingSegmentStatus('completed'), true);
  assert.equal(isTerminalMeetingSegmentStatus('failed'), true);
});
