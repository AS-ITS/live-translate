import { classifyConnectionFailure } from '../../lib/connectionFailures.js';

const MEETING_CHECKPOINT_STATUS_LABELS = {
  idle: '會議模式：尚未啟用',
  ready: '會議模式：準備中',
  syncing: '會議模式：保存中',
  synced: '會議模式：已保存',
  switching: '會議模式：切換段落中',
  switched: '會議模式：下一段已開始',
  error: '會議模式：保存失敗，等待重試'
};

const RECORDING_STATUS_LABELS = {
  idle: '尚無可下載的原始語音。',
  skipped: '未錄製講者原音。',
  recording: '正在保留本機麥克風輸入。',
  paused: '錄音已暫停，已保留目前片段。',
  finalizing: '正在完成錄音檔。',
  ready: '原始語音已可下載。',
  saved: '音檔已保存，請到翻譯紀錄下載。',
  error: '原始語音錄音無法使用。'
};

const TRANSLATED_AUDIO_STATUS_LABELS = {
  idle: '尚無可下載的翻譯語音。',
  recording: '正在保留即時字幕輸出。',
  ready: '翻譯語音已可下載。',
  saved: '音檔已保存，請到翻譯紀錄下載。',
  error: '翻譯語音音檔無法使用。'
};

export function meetingCheckpointStatusLabel(status) {
  return MEETING_CHECKPOINT_STATUS_LABELS[status] || MEETING_CHECKPOINT_STATUS_LABELS.idle;
}

export function meetingCheckpointErrorMessageFor(error) {
  const messages = {
    subtitle_cue_invalid: '字幕資料格式無效，請重新開始錄製。',
    invalid_json: 'checkpoint 請求格式無效。',
    invalid_request: 'checkpoint 請求內容不完整。'
  };
  if (error?.status === 400 || messages[error?.code]) {
    return messages[error?.code] || 'checkpoint 請求無效，請重新開始錄製。';
  }
  return '';
}

export function recordingStatusLabel(status) {
  return RECORDING_STATUS_LABELS[status] || RECORDING_STATUS_LABELS.idle;
}

export function translatedAudioStatusLabel(status) {
  return TRANSLATED_AUDIO_STATUS_LABELS[status] || TRANSLATED_AUDIO_STATUS_LABELS.idle;
}

export function composeCheckpointStatusMessage({
  meetingCheckpointStatus,
  checkpointErrorMessage = '',
  shouldRecordInputAudio,
  recordingState,
  translatedAudioState
}) {
  const messages = [meetingCheckpointStatusLabel(meetingCheckpointStatus)];
  if (checkpointErrorMessage) messages.push(checkpointErrorMessage);
  const inputAudioIsActive = shouldRecordInputAudio && ['recording', 'paused', 'finalizing', 'ready', 'saved', 'error'].includes(recordingState?.status);
  const translationAudioIsActive = ['recording', 'ready', 'saved', 'error'].includes(translatedAudioState?.status);

  if (inputAudioIsActive) {
    messages.push(`原始語音：${recordingStatusLabel(recordingState.status)}`);
    if (recordingState.errorMessage) messages.push(`原始語音錯誤：${recordingState.errorMessage}`);
  }

  if (translationAudioIsActive) {
    messages.push(`翻譯語音：${translatedAudioStatusLabel(translatedAudioState.status)}`);
    if (translatedAudioState.errorMessage) messages.push(`翻譯語音錯誤：${translatedAudioState.errorMessage}`);
  }

  return messages;
}

export function hasAudioStatusError({ shouldRecordInputAudio, recordingState, translatedAudioState }) {
  return (shouldRecordInputAudio && recordingState?.status === 'error') || translatedAudioState?.status === 'error';
}

export function classifyFailureSignal(failure) {
  const rawClassification = classifyConnectionFailure({
    error: failure.rawError,
    rawError: failure.rawError,
    rawEvent: failure.rawEvent,
    code: failure.rawError?.code || failure.rawEvent?.code,
    status: failure.rawError?.status || failure.rawEvent?.status,
    context: failure.source
  });

  if (rawClassification.reason !== 'unknown_error') return rawClassification;

  return classifyConnectionFailure({
    reason: failure.reasonHint,
    error: failure.rawError,
    rawError: failure.rawError,
    rawEvent: failure.rawEvent,
    context: failure.source
  });
}
