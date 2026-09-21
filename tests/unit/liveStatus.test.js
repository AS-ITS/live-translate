import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyFailureSignal, composeCheckpointStatusMessage, hasAudioStatusError, meetingCheckpointErrorMessageFor } from '../../src/features/live/liveStatus.js';

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

test('maps checkpoint validation errors to safe Chinese messages', () => {
  assert.equal(meetingCheckpointErrorMessageFor({ status: 400, code: 'subtitle_cue_invalid' }), '字幕資料格式無效，請重新開始錄製。');
  assert.equal(meetingCheckpointErrorMessageFor({ status: 400, code: 'invalid_json' }), 'checkpoint 請求格式無效。');
  assert.equal(meetingCheckpointErrorMessageFor({ status: 400, code: 'invalid_request' }), 'checkpoint 請求內容不完整。');
  assert.equal(meetingCheckpointErrorMessageFor({ status: 400, code: 'internal_error' }), 'checkpoint 請求無效，請重新開始錄製。');
  assert.equal(meetingCheckpointErrorMessageFor({ status: 500, code: 'subtitle_cue_invalid' }), '字幕資料格式無效，請重新開始錄製。');
});

test('includes checkpoint error details in the live status message', () => {
  assert.deepEqual(composeCheckpointStatusMessage({
    meetingCheckpointStatus: 'error',
    checkpointErrorMessage: '字幕資料格式無效，請重新開始錄製。（請提供 Request ID：request-1）',
    shouldRecordInputAudio: false,
    recordingState: { status: 'idle' },
    translatedAudioState: { status: 'idle' }
  }), [
    '會議模式：保存失敗，等待重試',
    '字幕資料格式無效，請重新開始錄製。（請提供 Request ID：request-1）'
  ]);
});

test('classifies nested provider authorization status from a live error event', () => {
  const classification = classifyFailureSignal({
    source: 'live_error',
    rawError: new Error('provider authorization failed'),
    rawEvent: { error: { status: 403, code: 'auth_failed' } },
    reasonHint: 'provider_error'
  });

  assert.equal(classification.reason, 'auth_failed');
  assert.equal(classification.httpStatus, 403);
});
