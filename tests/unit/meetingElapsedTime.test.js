import assert from 'node:assert/strict';
import test from 'node:test';
import { formatMeetingElapsed, meetingElapsedMs } from '../../src/lib/meetingElapsedTime.js';

test('meeting elapsed time is derived from authoritative timestamps after delayed timer callbacks', () => {
  const startedAt = '2026-10-07T00:00:00.000Z';
  assert.equal(meetingElapsedMs(startedAt, '2026-10-07T01:17:43.900Z'), 4_663_900);
  assert.equal(formatMeetingElapsed(meetingElapsedMs(startedAt, '2026-10-07T01:17:43.900Z')), '01:17:43');
});

test('meeting elapsed time remains based on fixed startedAt across pause, resume, reconnect, and rollover renders', () => {
  const startedAt = 1_000;
  const renderTimes = [
    ['pause', 61_000],
    ['resume', 121_000],
    ['reconnect', 181_000],
    ['rollover', 241_000]
  ];
  assert.deepEqual(renderTimes.map(([event, now]) => [event, meetingElapsedMs(startedAt, now)]), [
    ['pause', 60_000],
    ['resume', 120_000],
    ['reconnect', 180_000],
    ['rollover', 240_000]
  ]);
});
