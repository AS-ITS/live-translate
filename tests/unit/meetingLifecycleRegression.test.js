import assert from 'node:assert/strict';
import test from 'node:test';
import { completeMeetingAfterRecordingFinalize } from '../../src/features/live/useLiveRecordingController.js';

test('end meeting awaits audio, cue, and checkpoint finalization and stays idempotent on retry', async () => {
  const calls = [];
  let completed = 0;
  const flush = (name) => async () => {
    calls.push(`${name}:start`);
    await Promise.resolve();
    calls.push(`${name}:done`);
  };

  const first = await completeMeetingAfterRecordingFinalize({
    flushAudio: flush('audio'),
    flushCues: flush('cues'),
    flushCheckpoint: flush('checkpoint'),
    completeMeeting: async () => { completed += 1; calls.push('meeting:complete'); }
  });
  const second = await completeMeetingAfterRecordingFinalize({
    flushAudio: flush('audio-retry'),
    flushCues: flush('cues-retry'),
    flushCheckpoint: flush('checkpoint-retry'),
    completeMeeting: async () => { completed += 1; calls.push('meeting:complete-retry'); },
    alreadyCompleted: first
  });

  assert.equal(first, true);
  assert.equal(second, true);
  assert.equal(completed, 1);
  assert.deepEqual(calls, [
    'audio:start', 'audio:done',
    'cues:start', 'cues:done',
    'checkpoint:start', 'checkpoint:done',
    'meeting:complete'
  ]);
});
