import { withHttpStatus } from './connectionFailures.js';

const MANUAL_RECOVERY_MESSAGES = {
  auth_failed: '存取失敗。請檢查存取權杖或設定。',
  rate_limited: '請求過於頻繁。請稍候再試。'
};

const STATUS_LABELS = {
  auth_failed: '存取失敗',
  rate_limited: '請求受限',
  network_offline: '網路離線'
};

export function failureUiStateForClassification(classification = {}) {
  const reason = classification.reason || 'unknown_error';
  const safeMessage = classification.safeMessage || '即時翻譯失敗。請再試一次。';
  const visibleSafeMessage = withHttpStatus(safeMessage, classification.httpStatus);
  const baseState = {
    reason,
    status: 'error',
    statusLabel: '',
    message: visibleSafeMessage,
    safeMessage,
    shouldReconnect: false,
    suppressSessionError: true,
    clearSession: true,
    startEnabled: true,
    stopVisible: false
  };

  if (reason === 'auth_failed' || reason === 'rate_limited') {
    return {
      ...baseState,
      status: 'error',
      statusLabel: STATUS_LABELS[reason],
      message: withHttpStatus(MANUAL_RECOVERY_MESSAGES[reason], classification.httpStatus)
    };
  }

  if (reason === 'network_offline') {
    return {
      ...baseState,
      status: 'reconnecting',
      statusLabel: STATUS_LABELS[reason],
      message: '',
      shouldReconnect: true,
      clearSession: false,
      startEnabled: false,
      stopVisible: true
    };
  }

  if (shouldReconnect(reason)) {
    return {
      ...baseState,
      status: 'reconnecting',
      message: '',
      shouldReconnect: true,
      clearSession: false,
      startEnabled: false,
      stopVisible: true
    };
  }

  return baseState;
}

function shouldReconnect(reason) {
  return [
    'unexpected_close',
    'network_offline',
    'token_expired',
    'token_request_failed',
    'live_connect_failed',
    'network_timeout',
    'network_interrupted',
    'provider_unavailable',
    'provider_error',
    'browser_suspended',
    'audio_context_lost',
    'selected_device_missing',
    'pcm_send_failed'
  ].includes(reason);
}
