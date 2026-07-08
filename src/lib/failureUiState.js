const MANUAL_RECOVERY_MESSAGES = {
  token_expired: 'Session expired. Please start a new session.',
  auth_failed: 'Access failed. Please check your access token or configuration.',
  rate_limited: 'Too many requests. Please wait and try again.'
};

const STATUS_LABELS = {
  auth_failed: 'Access failed',
  rate_limited: 'Rate limited'
};

export function failureUiStateForClassification(classification = {}) {
  const reason = classification.reason || 'unknown_error';
  const safeMessage = classification.safeMessage || 'Live translation failed. Please try again.';
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
