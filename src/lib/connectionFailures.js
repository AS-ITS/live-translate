const CATEGORIES = {
  permission: ['permission_denied', 'permission_revoked'],
  token: ['token_request_failed', 'token_expired', 'auth_failed', 'rate_limited'],
  network: ['network_offline', 'network_timeout', 'network_interrupted'],
  provider: ['provider_unavailable', 'provider_error', 'live_connect_failed', 'unexpected_close'],
  browser_runtime: ['browser_suspended', 'audio_context_lost'],
  audio_device: ['microphone_disconnected', 'selected_device_missing', 'audio_capture_failed'],
  user_intent: ['user_stop', 'page_unload'],
  cleanup: ['cleanup_failed'],
  unknown: ['unknown_error']
};

const REASONS = Object.fromEntries(
  Object.entries(CATEGORIES).flatMap(([category, reasons]) => reasons.map((reason) => [reason, category]))
);

const SAFE_MESSAGES = {
  permission_denied: 'Microphone permission was denied. Allow microphone access and try again.',
  permission_revoked: 'Microphone permission is no longer available. Allow microphone access and try again.',
  token_request_failed: 'Unable to prepare a live translation session. Please try again.',
  token_expired: 'The live translation session expired. Reconnecting requires a new session.',
  auth_failed: 'Live translation access is not authorized. Please contact the operator.',
  rate_limited: 'Too many live translation requests. Please wait and try again.',
  network_offline: 'The browser is offline. Reconnect when the network is available.',
  network_timeout: 'The live translation service took too long to respond. Please try again.',
  network_interrupted: 'The network connection was interrupted. Please try again.',
  provider_unavailable: 'The live translation provider is temporarily unavailable. Please try again.',
  provider_error: 'The live translation provider returned an error. Please try again.',
  live_connect_failed: 'Unable to connect to live translation. Please try again.',
  unexpected_close: 'The live translation session closed unexpectedly. Please try again.',
  browser_suspended: 'The browser paused the live translation session. Please try again.',
  audio_context_lost: 'The browser audio session was interrupted. Please try again.',
  microphone_disconnected: 'The selected microphone disconnected. Check the microphone and try again.',
  selected_device_missing: 'The selected microphone is unavailable. Use another microphone and try again.',
  audio_capture_failed: 'Unable to capture microphone audio. Check the microphone and try again.',
  user_stop: 'Live translation was stopped.',
  page_unload: 'The page was closed or reloaded.',
  cleanup_failed: 'Live translation cleanup did not complete. Please restart the session.',
  unknown_error: 'Live translation failed. Please try again.'
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
  return classificationFor(reason);
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

function classificationFor(reason) {
  const safeReason = REASONS[reason] ? reason : 'unknown_error';
  return {
    reason: safeReason,
    category: REASONS[safeReason],
    recoverable: !NON_RECOVERABLE_REASONS.has(safeReason),
    requiresUserAction: USER_ACTION_REASONS.has(safeReason),
    requiresFreshToken: FRESH_TOKEN_REASONS.has(safeReason),
    stopRecovery: STOP_RECOVERY_REASONS.has(safeReason),
    safeMessage: SAFE_MESSAGES[safeReason]
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
    status: input?.status || input?.response?.status || error?.status || error?.response?.status,
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
