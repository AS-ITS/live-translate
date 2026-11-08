import assert from 'node:assert/strict';
import test from 'node:test';
import { activateRecoveredMeetingSegment, closeLocalPcmWriterAfterPause, completeMeetingAfterRecordingFinalize,
  meetingRequestErrorMessage,
  openLocalPcmWriterAfterContinue } from '../../src/features/live/useLiveRecordingController.js';

test('local Pause waits for writer CLOSE before Continue opens a fresh writer', async () => {
  const calls = [];
  let releaseClose;
  let writer;
  const closing = closeLocalPcmWriterAfterPause({
    operationId: 'pause:recording-1:segment-1', recordInputAudio: true,
    closePcmJournal: async () => {
      calls.push('close:start');
      await new Promise((resolve) => { releaseClose = resolve; });
      calls.push('close:done');
    }
  });
  assert.deepEqual(calls, ['close:start']);
  releaseClose();
  await closing;
  await openLocalPcmWriterAfterContinue({ localOnly: true, recordInputAudio: true,
    resumed: { meeting: { id: 'meeting-1' }, session: { id: 'recording-1' } },
    prepareInputAudioDownload: (record, options) => {
      assert.deepEqual(record, { id: 'recording-1', meetingId: 'meeting-1', recordingId: 'recording-1' });
      assert.deepEqual(options, { preserveBuffer: true });
      calls.push('prepare');
      writer = { open: async () => { calls.push('open'); } };
    },
    pcmJournal: () => writer
  });
  assert.deepEqual(calls, ['close:start', 'close:done', 'prepare', 'open']);
});

test('successful recover activates next segment and reports recover errors separately from checkpoint errors', () => {
  const activeRef = { current: { meetingId: 'm', segmentId: 'old' } };
  const sync = [];
  activateRecoveredMeetingSegment({ meetingId: 'm', recoveryResult: { segment: { id: 'next' } }, activeMeetingCheckpointRef: activeRef, startCheckpointSync: (value) => sync.push(value) });
  assert.deepEqual(activeRef.current, { meetingId: 'm', segmentId: 'next' });
  assert.deepEqual(sync, [activeRef.current]);

  const message = meetingRequestErrorMessage({ operation: 'recover-segment', status: 409, code: 'checkpoint_conflict', requestId: 'req-1' });
  assert.match(message, /^recover HTTP 409/);
  assert.match(message, /checkpoint_conflict/);
  assert.match(message, /req-1/);
  assert.doesNotMatch(message, /^checkpoint/);
});

test('local Journal handoff failures do not report Pause or Continue success', async () => {
  await assert.rejects(closeLocalPcmWriterAfterPause({
    operationId: 'pause-1', recordInputAudio: true,
    closePcmJournal: async () => { throw new Error('close failed'); }
  }), /close failed/);
  await assert.rejects(openLocalPcmWriterAfterContinue({ localOnly: true, recordInputAudio: true,
    resumed: { meeting: { id: 'meeting-1' }, session: { id: 'recording-1' } },
    prepareInputAudioDownload: () => {},
    pcmJournal: () => ({ open: async () => { throw new Error('open failed'); } })
  }), /open failed/);
});

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
    completeMeeting: async () => { completed += 1; calls.push('meeting:complete'); },
    completeMeetingMetadata: async () => { calls.push('metadata:complete'); }
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
    'meeting:complete',
    'metadata:complete'
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

test('End accepts a durable local seal without a decoded audio Blob', async () => {
  let completed = false;
  await completeMeetingAfterRecordingFinalize({
    flushAudio: async () => ({ status: 'sealed', blob: null }),
    flushTranslatedAudio: async () => ({ status: 'sealed', blob: null }),
    closePcmJournal: async () => {},
    completeMeeting: async () => { completed = true; }
  });
  assert.equal(completed, true);
});

test('End keeps metadata incomplete when local finalize fails or metadata sync rejects', async () => {
  let metadataCalls = 0;
  await assert.rejects(completeMeetingAfterRecordingFinalize({
    completeMeeting: async () => { throw new Error('local finalize failed'); },
    completeMeetingMetadata: async () => { metadataCalls += 1; }
  }), /local finalize failed/);
  assert.equal(metadataCalls, 0);

  await assert.rejects(completeMeetingAfterRecordingFinalize({
    completeMeeting: async () => {},
    completeMeetingMetadata: async () => { metadataCalls += 1; throw new Error('metadata sync failed'); }
  }), /metadata sync failed/);
  assert.equal(metadataCalls, 1);
});
