import test from 'node:test';
import assert from 'node:assert/strict';
import { getAudioDiagnosticSnapshot, recordAudioFailure, recordAudioRecorderState, subscribeAudioDiagnostics } from '../../src/lib/audioFailureDiagnostic.js';

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
    stage: 'AUDIO_CHUNK_WRITE', operation: 'OPFS_WRITE', storageOperation: null,
    errorOrigin: 'OTHER', errorName: 'QuotaExceededError',
    writerState: 'recording', queueDepth: 2, chunkBytes: 4096,
    segmentId: entries[1][1].segmentId, elapsedMs: 123
  });
  assert.match(entries[0][1].segmentId, /^segment_[a-z0-9]+$/u);
  assert.equal(entries[2][1].audioPath, null);
  assert.equal(entries[2][1].operation, null);
  assert.equal(entries[2][1].errorName, 'UNCLASSIFIED');
  assert.doesNotMatch(JSON.stringify(entries), /private|secret|subtitle|stack|token/u);
});

test('audio diagnostic snapshot keeps ten allowlisted events in page memory and separates MIME from chunk success', () => {
  const originalInfo = console.info;
  console.info = () => {};
  let notifications = 0;
  const unsubscribe = subscribeAudioDiagnostics(() => { notifications += 1; });
  try {
    recordAudioRecorderState({ mimeType: 'audio/mp4', chunkRecorded: false });
    assert.equal(getAudioDiagnosticSnapshot().recorderMimeType, 'audio/mp4');
    assert.equal(getAudioDiagnosticSnapshot().recordedChunk, false);
    recordAudioRecorderState({ mimeType: 'audio/mp4', chunkRecorded: true });
    for (let index = 0; index < 12; index += 1) {
      recordAudioFailure({ audioPath: 'ORIGINAL_AUDIO', stage: 'PCM_CAPTURE',
        error: { code: 'MEDIA_RECORDER_ERROR', message: 'secret token subtitle', stack: 'private stack' },
        segmentId: 'private-meeting-id' });
    }
    const snapshot = getAudioDiagnosticSnapshot();
    assert.equal(snapshot.events.length, 10);
    assert.equal(snapshot.recordedChunk, true);
    assert.deepEqual(Object.keys(snapshot.events[0]), ['audioPath', 'stage', 'code', 'storageOperation', 'errorOrigin', 'at']);
    assert.match(snapshot.events[0].at, /^\d{4}-\d{2}-\d{2}T/u);
    assert.doesNotMatch(JSON.stringify(snapshot), /secret|token|subtitle|private|meetingId|segmentId|stack/u);
    recordAudioRecorderState({ mimeType: 'audio/mp4;secret=token' });
    assert.equal(getAudioDiagnosticSnapshot().recorderMimeType, 'unknown');
    assert.equal(notifications, 15);
  } finally {
    unsubscribe();
    console.info = originalInfo;
  }
});

test('audio diagnostic rejects unrecognized storage operation text', () => {
  const originalInfo = console.info;
  const entries = [];
  console.info = (...args) => entries.push(args);
  try {
    const error = new DOMException('private subtitle content', 'UnknownError');
    error.opfsOperation = 'privateSubtitleContent';
    recordAudioFailure({ audioPath: 'TRANSLATED_AUDIO', stage: 'AUDIO_CHUNK_WRITE', error });
  } finally {
    console.info = originalInfo;
  }
  assert.equal(entries[0][1].storageOperation, null);
  assert.equal(getAudioDiagnosticSnapshot().events.at(-1).storageOperation, null);
  assert.doesNotMatch(JSON.stringify(entries), /private|subtitle|content|stack/iu);
});

test('audio diagnostic identifies the OPFS step and native DOMException without exposing its message', () => {
  const originalInfo = console.info;
  const entries = [];
  console.info = (...args) => entries.push(args);
  try {
    const error = new DOMException('private path and PCM', 'UnknownError');
    error.opfsOperation = 'WRITABLE_CREATE';
    recordAudioFailure({ audioPath: 'TRANSLATED_AUDIO', stage: 'AUDIO_CHUNK_WRITE', error });
  } finally {
    console.info = originalInfo;
  }
  assert.equal(entries[0][1].storageOperation, 'WRITABLE_CREATE');
  assert.equal(entries[0][1].errorOrigin, 'DOM_EXCEPTION');
  assert.equal(entries[0][1].errorName, 'UnknownError');
  assert.equal(getAudioDiagnosticSnapshot().events.at(-1).storageOperation, 'WRITABLE_CREATE');
  assert.doesNotMatch(JSON.stringify(entries), /private|PCM/u);
});
