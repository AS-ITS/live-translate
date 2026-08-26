import assert from 'node:assert/strict';
import test from 'node:test';
import { createMeetingEventBroadcaster } from '../../src/infrastructure/meetingEventBroadcaster.js';

function cue(overrides = {}) {
  return {
    cueId: 'cue-1',
    sequence: 1,
    status: 'final',
    sourceText: '原文',
    translatedText: 'translation',
    ...overrides
  };
}

test('Meeting broadcaster sequences, replays, and deduplicates Cue events', () => {
  let now = 100;
  const broadcaster = createMeetingEventBroadcaster({ clock: () => now, historyLimit: 2 });
  const events = [];
  broadcaster.subscribe('meeting-1', (event) => events.push(event));

  const first = broadcaster.publish('meeting-1', { segmentId: 'segment-1', cue: cue(), producedAt: 50 });
  const duplicate = broadcaster.publish('meeting-1', { segmentId: 'segment-1', cue: cue(), producedAt: 60 });
  now = 200;
  const refined = broadcaster.publish('meeting-1', { segmentId: 'segment-1', cue: cue({ refinement: { version: 2 }, translatedText: 'refined' }) });

  assert.equal(first.eventId, 1);
  assert.equal(duplicate.eventId, 1);
  assert.equal(refined.eventId, 2);
  assert.equal(events.length, 2);
  assert.deepEqual(broadcaster.eventsSince('meeting-1', 1).events.map((event) => event.eventId), [2]);
  assert.deepEqual(broadcaster.cursor('meeting-1'), { eventId: 2, cueSequence: 1 });
});

test('Meeting broadcaster reports a replay gap after history overflow', () => {
  const broadcaster = createMeetingEventBroadcaster({ historyLimit: 2 });
  broadcaster.publish('meeting-1', { cue: cue({ cueId: 'cue-1', sequence: 1 }) });
  broadcaster.publish('meeting-1', { cue: cue({ cueId: 'cue-2', sequence: 2 }) });
  broadcaster.publish('meeting-1', { cue: cue({ cueId: 'cue-3', sequence: 3 }) });
  broadcaster.publish('meeting-1', { cue: cue({ cueId: 'cue-4', sequence: 4 }) });

  const replay = broadcaster.eventsSince('meeting-1', 1);
  assert.equal(replay.gap, true);
  assert.deepEqual(replay.events.map((event) => event.eventId), [3, 4]);
});
