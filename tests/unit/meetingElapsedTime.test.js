import assert from 'node:assert/strict';
import test from 'node:test';
import { clearMeetingTimer, formatMeetingElapsed, meetingElapsedMs, readMeetingTimerStart, startMeetingTimer } from '../../src/lib/meetingElapsedTime.js';

test('meeting elapsed time uses a fixed UI start after delayed timer callbacks', () => {
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

test('meeting timer survives repeated reads, keeps its start on Continue, and isolates meetings', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const items = new Map();
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => items.set(key, value),
    removeItem: (key) => items.delete(key)
  } });
  try {
    assert.equal(startMeetingTimer('meeting-a', 1_000), 1_000);
    assert.equal(readMeetingTimerStart('meeting-a'), 1_000);
    assert.equal(meetingElapsedMs(readMeetingTimerStart('meeting-a'), 61_000), 60_000);
    assert.equal(startMeetingTimer('meeting-a', 90_000), 1_000);
    assert.equal(readMeetingTimerStart('meeting-a'), 1_000);
    assert.equal(readMeetingTimerStart('meeting-b'), null);
    assert.equal(startMeetingTimer('meeting-b', 91_000), 91_000);
    clearMeetingTimer('meeting-a');
    assert.equal(readMeetingTimerStart('meeting-a'), null);
    assert.equal(readMeetingTimerStart('meeting-b'), 91_000);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'sessionStorage', previous);
    else delete globalThis.sessionStorage;
  }
});

test('unavailable sessionStorage leaves the timer hidden', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get: () => { throw new Error('blocked'); } });
  try {
    assert.equal(startMeetingTimer('meeting-a', 1_000), null);
    assert.equal(readMeetingTimerStart('meeting-a'), null);
    assert.doesNotThrow(() => clearMeetingTimer('meeting-a'));
  } finally {
    if (previous) Object.defineProperty(globalThis, 'sessionStorage', previous);
    else delete globalThis.sessionStorage;
  }
});
