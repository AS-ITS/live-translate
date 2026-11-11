import test from 'node:test';
import assert from 'node:assert/strict';
import { recordAudioFailure } from '../../src/lib/audioFailureDiagnostic.js';

test('audio failure diagnostic emits only bounded metadata with nonidentifying segment correlation', () => {
  const originalInfo = console.info;
  const entries = [];
  console.info = (...args) => entries.push(args);
  try {
    const input = {
      audioPath: 'PCM_JOURNAL',
      stage: 'AUDIO_CHUNK_WRITE', operation: 'OPFS_WRITE',
      error: { name: 'QuotaExceededError', message: 'private PCM and secret', stack: 'private stack' },
      writerState: 'recording', queueDepth: 2, chunkBytes: 4096,
      segmentId: 'private-segment-id', elapsedMs: 123
    };
    recordAudioFailure(input);
    recordAudioFailure({ ...input, operation: 'OPFS_FLUSH' });
    recordAudioFailure({ ...input, audioPath: 'private token', operation: 'private token',
      error: { code: 'private token', name: 'private token', message: 'private subtitle' } });
    recordAudioFailure({ ...input, stage: 'UNTRUSTED', operation: 'private PCM and secret' });
  } finally {
    console.info = originalInfo;
  }
  assert.equal(entries.length, 3);
  assert.equal(entries[0][0], 'ISSUE41_AUDIO_FAILURE');
  assert.deepEqual(entries[0][1], {
    audioPath: 'PCM_JOURNAL',
    stage: 'AUDIO_CHUNK_WRITE', operation: 'OPFS_WRITE', errorName: 'QuotaExceededError',
    writerState: 'recording', queueDepth: 2, chunkBytes: 4096,
    segmentId: entries[1][1].segmentId, elapsedMs: 123
  });
  assert.match(entries[0][1].segmentId, /^segment_[a-z0-9]+$/u);
  assert.equal(entries[2][1].audioPath, null);
  assert.equal(entries[2][1].operation, null);
  assert.equal(entries[2][1].errorName, 'UNCLASSIFIED');
  assert.doesNotMatch(JSON.stringify(entries), /private|secret|subtitle|stack|token/u);
});
