const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 750;
const DEFAULT_MAX_DELAY_MS = 8000;
const DEFAULT_RECOVERY_WINDOW_MS = 30000;
const DEFAULT_JITTER_RATIO = 0;

const NON_RETRYABLE_REASONS = new Set([
  'user_stop',
  'cleanup_failed',
  'auth_failed',
  'permission_denied',
  'permission_revoked',
  'page_unload'
]);

export function createRetryState(options = {}) {
  const config = normalizeOptions(options);
  return {
    attempts: 0,
    firstAttemptAt: null,
    lastAttemptAt: null,
    maxAttempts: config.maxAttempts,
    recoveryWindowMs: config.recoveryWindowMs
  };
}

export function resetRetryState(options = {}) {
  return createRetryState(options);
}

export function nextRetryDecision(retryState, classification, options = {}) {
  const state = retryState || createRetryState(options);
  const config = normalizeOptions({
    maxAttempts: state.maxAttempts,
    recoveryWindowMs: state.recoveryWindowMs,
    ...options
  });
  const reason = classification?.reason || 'unknown_error';
  const attempt = state.attempts + 1;
  const maxAttempts = config.maxAttempts;

  if (reason === 'network_offline') {
    return baseDecision({ reason, attempt, maxAttempts, paused: true, stopReason: 'offline' });
  }

  if (reason === 'rate_limited') {
    return baseDecision({ reason, attempt, maxAttempts, stopReason: 'rate_limited' });
  }

  if (NON_RETRYABLE_REASONS.has(reason) || classification?.stopRecovery || classification?.recoverable === false) {
    return baseDecision({ reason, attempt, maxAttempts, stopReason: reason });
  }

  if (state.attempts >= maxAttempts) {
    return baseDecision({ reason, attempt, maxAttempts, stopReason: 'max_attempts_exceeded' });
  }

  if (isRecoveryWindowExceeded(state, config.now, config.recoveryWindowMs)) {
    return baseDecision({ reason, attempt, maxAttempts, stopReason: 'recovery_window_exceeded' });
  }

  return {
    shouldRetry: true,
    delayMs: retryDelayMs(attempt, config),
    reason,
    attempt,
    maxAttempts,
    paused: false
  };
}

export function recordRetryAttempt(retryState, decision, now = 0) {
  const state = retryState || createRetryState();

  if (!decision?.shouldRetry || decision.paused) {
    return { ...state };
  }

  return {
    ...state,
    attempts: state.attempts + 1,
    firstAttemptAt: state.firstAttemptAt ?? now,
    lastAttemptAt: now
  };
}

function baseDecision({ reason, attempt, maxAttempts, paused = false, stopReason }) {
  return {
    shouldRetry: false,
    delayMs: 0,
    reason,
    attempt,
    maxAttempts,
    paused,
    ...(stopReason ? { stopReason } : {})
  };
}

function retryDelayMs(attempt, config) {
  const exponentialDelay = config.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const jitteredDelay = exponentialDelay * jitterMultiplier(config.random, config.jitterRatio);
  return Math.min(config.maxDelayMs, Math.round(jitteredDelay));
}

function jitterMultiplier(random, jitterRatio) {
  if (!jitterRatio) {
    return 1;
  }

  const randomValue = clamp(random(), 0, 1);
  return 1 + (randomValue - 0.5) * jitterRatio;
}

function isRecoveryWindowExceeded(state, now, recoveryWindowMs) {
  if (state.firstAttemptAt === null || state.firstAttemptAt === undefined) {
    return false;
  }

  return now - state.firstAttemptAt > recoveryWindowMs;
}

function normalizeOptions(options = {}) {
  return {
    maxAttempts: positiveInteger(options.maxAttempts, DEFAULT_MAX_ATTEMPTS),
    baseDelayMs: positiveNumber(options.baseDelayMs, DEFAULT_BASE_DELAY_MS),
    maxDelayMs: positiveNumber(options.maxDelayMs, DEFAULT_MAX_DELAY_MS),
    recoveryWindowMs: positiveNumber(options.recoveryWindowMs, DEFAULT_RECOVERY_WINDOW_MS),
    jitterRatio: nonNegativeNumber(options.jitterRatio, DEFAULT_JITTER_RATIO),
    random: typeof options.random === 'function' ? options.random : () => 0.5,
    now: Number.isFinite(options.now) ? options.now : 0
  };
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function positiveNumber(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegativeNumber(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
