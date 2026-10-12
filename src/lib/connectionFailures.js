const CATEGORIES = {
  permission: ['permission_denied', 'permission_revoked'],
  token: ['token_request_failed', 'token_expired', 'auth_failed', 'rate_limited'],
  network: ['network_offline', 'network_timeout', 'network_interrupted'],
  provider: ['provider_unavailable', 'provider_error', 'live_connect_failed', 'unexpected_close'],
  browser_runtime: ['browser_suspended', 'audio_context_lost'],
  audio_device: ['microphone_disconnected', 'selected_device_missing', 'microphone_stream_invalid', 'audio_capture_failed', 'pcm_send_failed'],
  audio_pipeline: ['audio_callback_not_received', 'pcm_generation_failed', 'first_pcm_timeout'],
  user_intent: ['user_stop', 'page_unload'],
  cleanup: ['cleanup_failed'],
  unknown: ['unknown_error']
};

const REASONS = Object.fromEntries(
  Object.entries(CATEGORIES).flatMap(([category, reasons]) => reasons.map((reason) => [reason, category]))
);

const SAFE_MESSAGES = {
  permission_denied: '麥克風權限遭拒。請允許麥克風存取後再試一次。',
  permission_revoked: '麥克風權限已無法使用。請允許麥克風存取後再試一次。',
  token_request_failed: '無法準備即時翻譯工作階段。請再試一次。',
  token_expired: '即時翻譯工作階段已過期。重新連線需要建立新的工作階段。',
  auth_failed: '未獲授權使用即時翻譯。請聯絡管理員。',
  rate_limited: '即時翻譯請求過於頻繁。請稍候再試。',
  network_offline: '瀏覽器目前離線。請在網路恢復後重新連線。',
  network_timeout: '即時翻譯服務回應逾時。請再試一次。',
  network_interrupted: '網路連線中斷。請再試一次。',
  provider_unavailable: '即時翻譯服務暫時無法使用。請再試一次。',
  provider_error: '即時翻譯服務發生錯誤。請再試一次。',
  live_connect_failed: '無法連線至即時翻譯。請再試一次。',
  unexpected_close: '即時翻譯工作階段意外關閉。請再試一次。',
  browser_suspended: '瀏覽器暫停了即時翻譯工作階段。請再試一次。',
  audio_context_lost: '瀏覽器音訊工作階段中斷。請再試一次。',
  microphone_disconnected: '所選麥克風已中斷連線。請檢查麥克風後再試一次。',
  selected_device_missing: '所選麥克風無法使用。請改用其他麥克風後再試一次。',
  microphone_stream_invalid: '麥克風 track 已失效。請檢查麥克風後再試一次。',
  audio_capture_failed: '無法擷取麥克風音訊。請檢查麥克風後再試一次。',
  pcm_send_failed: '麥克風音訊已產生，但未送達即時翻譯服務。請重新連線。',
  audio_callback_not_received: '錄音音訊管線未啟動，請重試。',
  pcm_generation_failed: '錄音音訊管線未啟動，請重試。',
  first_pcm_timeout: '錄音音訊管線未啟動，請重試。',
  user_stop: '即時翻譯已停止。',
  page_unload: '頁面已關閉或重新載入。',
  cleanup_failed: '即時翻譯清理未完成。請重新啟動工作階段。',
  unknown_error: '即時翻譯失敗。請再試一次。'
};

const ERROR_CODE_MESSAGES = {
  auth_required: '登入狀態已失效，請重新登入。',
  auth_invalid: '登入狀態已失效，請重新登入。',
  auth_not_configured: '存取權杖未設定或無效，請聯絡管理員。',
  auth_forbidden: '目前帳號沒有錄音權限，請聯絡管理員。',
  invalid_origin: '此網站不允許請求即時翻譯，請檢查前端網址設定。',
  provider_unavailable: '即時翻譯服務暫時無法使用。請再試一次。',
  rate_limited: '開始即時翻譯的請求過於頻繁。請稍候再試。',
  server_misconfigured: '伺服器尚未設定即時翻譯。',
  unsupported_language: '不支援所選的目標語言。',
  invalid_json: '無法準備即時翻譯請求。',
  request_too_large: '即時翻譯請求過大。'
};

const NON_RECOVERABLE_REASONS = new Set([
  'permission_denied',
  'permission_revoked',
  'auth_failed',
  'cleanup_failed',
  'user_stop',
  'page_unload'
]);

const USER_ACTION_REASONS = new Set([
  'permission_denied',
  'permission_revoked',
  'auth_failed',
  'microphone_disconnected',
  'audio_capture_failed',
  'cleanup_failed'
]);

const FRESH_TOKEN_REASONS = new Set([
  'token_expired',
  'live_connect_failed',
  'unexpected_close',
  'provider_unavailable',
  'provider_error',
  'network_interrupted',
  'browser_suspended',
  'audio_context_lost',
  'microphone_disconnected',
  'selected_device_missing',
  'audio_capture_failed'
]);

const STOP_RECOVERY_REASONS = new Set([
  'permission_denied',
  'permission_revoked',
  'auth_failed',
  'cleanup_failed',
  'user_stop',
  'page_unload'
]);

export function classifyConnectionFailure(input = {}) {
  const normalized = normalizeInput(input);
  const reason = tokenExpirationReason(normalized) || explicitReason(normalized) || inferReason(normalized);
  return classificationFor(reason, normalized);
}

export function withHttpStatus(message, status) {
  const numericStatus = Number(status);
  if (!Number.isInteger(numericStatus) || numericStatus < 100 || numericStatus > 599) {
    return message;
  }
  const suffix = `（HTTP ${numericStatus}）`;
  return typeof message === 'string' && message.includes(suffix)
    ? message
    : `${message}${suffix}`;
}

export function userMessageForErrorCode(code) {
  return ERROR_CODE_MESSAGES[code] || null;
}

export function httpStatusFromError(input) {
  const candidates = [
    input?.status,
    input?.error?.status,
    input?.error?.error?.status,
    input?.response?.status,
    input?.error?.response?.status,
    input?.error?.error?.response?.status
  ];

  for (const candidate of candidates) {
    const numericStatus = Number(candidate);
    if (Number.isInteger(numericStatus) && numericStatus >= 100 && numericStatus <= 599) {
      return numericStatus;
    }
  }

  return null;
}

export function isRecoverableFailure(classification) {
  return Boolean(classification?.recoverable);
}

export function requiresUserAction(classification) {
  return Boolean(classification?.requiresUserAction);
}

export function requiresFreshToken(classification) {
  return Boolean(classification?.requiresFreshToken);
}

export function shouldStopRecovery(classification) {
  return Boolean(classification?.stopRecovery);
}

function classificationFor(reason, input = {}) {
  const safeReason = REASONS[reason] ? reason : 'unknown_error';
  return {
    reason: safeReason,
    category: REASONS[safeReason],
    recoverable: !NON_RECOVERABLE_REASONS.has(safeReason),
    requiresUserAction: USER_ACTION_REASONS.has(safeReason),
    requiresFreshToken: FRESH_TOKEN_REASONS.has(safeReason),
    stopRecovery: STOP_RECOVERY_REASONS.has(safeReason),
    safeMessage: SAFE_MESSAGES[safeReason],
    ...(Number.isInteger(input.status) && input.status >= 100 && input.status <= 599
      ? { httpStatus: input.status }
      : {})
  };
}

function normalizeInput(input) {
  if (typeof input === 'string') {
    return { reason: input };
  }

  const error = input?.error || input?.cause || input;
  return {
    ...input,
    error,
    name: input?.name || error?.name,
    code: input?.code || input?.error?.code || error?.code,
    status: httpStatusFromError(input)
      ?? httpStatusFromError(input?.rawError)
      ?? httpStatusFromError(input?.rawEvent),
    message: input?.message || input?.error?.message || error?.message,
    reason: input?.reason || input?.error?.reason || error?.reason,
    context: input?.context || error?.context,
    rawError: input?.rawError,
    rawEvent: input?.rawEvent
  };
}

function explicitReason(input) {
  return REASONS[input.reason] ? input.reason : null;
}

function inferReason(input) {
  if (isOffline(input)) {
    return 'network_offline';
  }

  const codeReason = reasonForCode(input.code);
  if (codeReason) {
    return codeReason;
  }

  const statusReason = reasonForStatus(input.status, input.context);
  if (statusReason) {
    return statusReason;
  }

  const nameReason = reasonForName(input.name, input.context);
  if (nameReason) {
    return nameReason;
  }

  return 'unknown_error';
}

function tokenExpirationReason(input) {
  if (normalizeText(input.reason) === 'token_expired' || normalizeText(input.code) === 'token_expired') {
    return 'token_expired';
  }

  return tokenExpirationMessage(input) ? 'token_expired' : null;
}

function tokenExpirationMessage(input) {
  return messageValues(input).some((value) => {
    const normalized = normalizeText(value);
    return (
      normalized.includes('token expired') ||
      normalized.includes('token expiration') ||
      normalized.includes('expired token') ||
      normalized.includes('session expired')
    );
  });
}

function messageValues(input) {
  return [
    input.message,
    input.error?.message,
    input.error?.reason,
    input.rawError?.message,
    input.rawError?.reason,
    input.rawEvent?.message,
    input.rawEvent?.reason
  ].filter(Boolean);
}

function isOffline(input) {
  if (input.offline === true) {
    return true;
  }

  return globalThis.navigator?.onLine === false;
}

function reasonForCode(code) {
  if (!code) {
    return null;
  }

  const normalized = normalizeText(code);
  if (REASONS[normalized]) {
    return normalized;
  }

  const codeMap = {
    auth_required: 'auth_failed',
    auth_invalid: 'auth_failed',
    auth_not_configured: 'auth_failed',
    invalid_origin: 'auth_failed',
    provider_unavailable: 'provider_unavailable',
    rate_limited: 'rate_limited',
    token_expired: 'token_expired',
    token_request_failed: 'token_request_failed',
    live_connect_failed: 'live_connect_failed'
  };

  return codeMap[normalized] || null;
}

function reasonForStatus(status, context) {
  if (!Number.isInteger(status)) {
    return null;
  }

  if (status === 401 || status === 403) {
    return 'auth_failed';
  }
  if (status === 429) {
    return 'rate_limited';
  }
  if ((status === 502 || status === 503 || status === 504) && isProviderContext(context)) {
    return 'provider_unavailable';
  }
  if (status === 408 || status === 504) {
    return 'network_timeout';
  }
  if (status === 502 || status === 503) {
    return 'provider_unavailable';
  }

  return null;
}

function reasonForName(name, context) {
  const normalized = normalizeText(name);

  if (normalized === 'notallowederror' || normalized === 'securityerror') {
    return 'permission_denied';
  }
  if (normalized === 'notfounderror' || normalized === 'overconstrainederror') {
    return 'selected_device_missing';
  }
  if (normalized === 'aborterror' || normalized === 'timeouterror') {
    return isAudioContext(context) ? 'audio_capture_failed' : 'network_timeout';
  }

  return null;
}

function isProviderContext(context) {
  const normalized = normalizeText(context);
  return normalized.includes('provider') || normalized.includes('gemini') || normalized.includes('live');
}

function isAudioContext(context) {
  const normalized = normalizeText(context);
  return normalized.includes('audio') || normalized.includes('microphone') || normalized.includes('mic') || normalized.includes('capture');
}

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}
