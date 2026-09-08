import test from 'node:test';
import assert from 'node:assert/strict';
import { composeCheckpointStatusMessage, hasAudioStatusError } from '../../src/features/live/liveStatus.js';

test('composes checkpoint and active audio status messages', () => {
  assert.deepEqual(composeCheckpointStatusMessage({
    meetingCheckpointStatus: 'synced',
    shouldRecordInputAudio: true,
    recordingState: { status: 'error', errorMessage: 'microphone failed' },
    translatedAudioState: { status: 'saved', errorMessage: '' }
  }), [
    '會議模式：已保存',
    '原始語音：原始語音錄音無法使用。',
    '原始語音錯誤：microphone failed',
    '翻譯語音：音檔已保存，請到翻譯紀錄下載。'
  ]);
});

test('reports audio errors only for enabled input or translated audio', () => {
  assert.equal(hasAudioStatusError({
    shouldRecordInputAudio: false,
    recordingState: { status: 'error' },
    translatedAudioState: { status: 'saved' }
  }), false);
  assert.equal(hasAudioStatusError({
    shouldRecordInputAudio: true,
    recordingState: { status: 'error' },
    translatedAudioState: { status: 'idle' }
  }), true);
});
