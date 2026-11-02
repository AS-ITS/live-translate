import assert from 'node:assert/strict';
import test from 'node:test';
import { completeMeetingAfterRecordingFinalize } from '../../src/features/live/useLiveRecordingController.js';

test('end meeting awaits every local write before metadata and stays idempotent on retry', async () => {
  const calls = [];
  let completed = 0;
  const flush = (name) => async () => {
    calls.push(`${name}:start`);
    await Promise.resolve();
    calls.push(`${name}:done`);
  };

  const first = await completeMeetingAfterRecordingFinalize({
    flushAudio: flush('audio'),
    flushTranslatedAudio: flush('translated-audio'),
    closePcmJournal: flush('pcm-journal'),
    flushCues: flush('cues'),
    flushTranscriptQueue: flush('transcript'),
    flushCheckpoint: flush('checkpoint'),
    flushCuePublishes: async () => { calls.push('local-cues:done'); return { localSaved: true, cloudSynced: false }; },
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
    'translated-audio:start', 'translated-audio:done',
    'pcm-journal:start', 'pcm-journal:done',
    'cues:start', 'cues:done',
    'transcript:start', 'transcript:done',
    'checkpoint:start', 'checkpoint:done',
    'local-cues:done',
    'meeting:complete'
  ]);
});

test('local audio, translated audio, transcript, Cue, and checkpoint failures prevent metadata completion', async () => {
  const failures = [
    { flushAudio: async () => ({ status: 'error' }) },
    { flushTranslatedAudio: async () => ({ status: 'error' }) },
    { closePcmJournal: async () => { throw new Error('journal close failed'); } },
    { flushTranscriptQueue: async () => { throw new Error('transcript write failed'); } },
    { flushCheckpoint: async () => false },
    { flushCuePublishes: async () => ({ localSaved: false, cloudSynced: true }) }
  ];
  for (const failure of failures) {
    let submitted = false;
    await assert.rejects(completeMeetingAfterRecordingFinalize({
      ...failure,
      completeMeeting: async () => { submitted = true; }
    }));
    assert.equal(submitted, false);
  }
  let submitted = false;
  await completeMeetingAfterRecordingFinalize({
    flushCuePublishes: async () => ({ localSaved: true, cloudSynced: false }),
    completeMeeting: async () => { submitted = true; }
  });
  assert.equal(submitted, true);
});
