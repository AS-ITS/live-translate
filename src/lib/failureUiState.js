const MANUAL_RECOVERY_MESSAGES = {
  token_expired: '工作階段已過期。請開始新的工作階段。',
  auth_failed: '存取失敗。請檢查存取權杖或設定。',
  rate_limited: '請求過於頻繁。請稍候再試。'
};

const STATUS_LABELS = {
  auth_failed: '存取失敗',
  rate_limited: '請求受限'
};

export function failureUiStateForClassification(classification = {}) {
  const reason = classification.reason || 'unknown_error';
  const safeMessage = classification.safeMessage || '即時翻譯失敗。請再試一次。';
  const baseState = {
    reason,
    status: 'error',
    statusLabel: '',
    message: safeMessage,
    safeMessage,
    shouldReconnect: false,
    suppressSessionError: true,
    clearSession: true,
    startEnabled: true,
    stopVisible: false
  };

  if (reason === 'token_expired') {
    return {
      ...baseState,
      status: 'expired',
      message: MANUAL_RECOVERY_MESSAGES.token_expired
    };
  }

  if (reason === 'auth_failed' || reason === 'rate_limited') {
    return {
      ...baseState,
      status: 'error',
      statusLabel: STATUS_LABELS[reason],
      message: MANUAL_RECOVERY_MESSAGES[reason]
    };
  }

  if (reason === 'unexpected_close') {
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
