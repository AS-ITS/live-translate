import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyConnectionFailure,
  isRecoverableFailure,
  requiresFreshToken,
  requiresUserAction,
  shouldStopRecovery
} from '../../src/lib/connectionFailures.js';

test('classifies permission denied DOMException', () => {
  const classification = classifyConnectionFailure({ name: 'NotAllowedError' });

  assert.equal(classification.reason, 'permission_denied');
  assert.equal(classification.category, 'permission');
  assert.equal(isRecoverableFailure(classification), false);
  assert.equal(requiresUserAction(classification), true);
});

test('classifies selected device missing DOMException names', () => {
  assert.equal(classifyConnectionFailure({ name: 'NotFoundError' }).reason, 'selected_device_missing');
  assert.equal(classifyConnectionFailure({ name: 'OverconstrainedError' }).reason, 'selected_device_missing');
});

test('classifies token expired from explicit code', () => {
  const classification = classifyConnectionFailure({ code: 'token_expired' });

  assert.equal(classification.reason, 'token_expired');
  assert.equal(classification.category, 'token');
  assert.equal(classification.recoverable, true);
});

test('classifies token expired from explicit reason', () => {
  const classification = classifyConnectionFailure({ reason: 'token_expired' });

  assert.equal(classification.reason, 'token_expired');
  assert.equal(classification.category, 'token');
  assert.equal(classification.recoverable, true);
});

test('classifies token expired from Live close payload message', () => {
  const classification = classifyConnectionFailure({
    reason: 'unexpected_close',
    rawEvent: { message: 'Live close payload: token expired' }
  });

  assert.equal(classification.reason, 'token_expired');
  assert.equal(classification.category, 'token');
});

test('classifies token expired from Live error payload message', () => {
  const classification = classifyConnectionFailure({
    reason: 'provider_error',
    rawError: new Error('Live error payload: session expired')
  });

  assert.equal(classification.reason, 'token_expired');
  assert.equal(classification.category, 'token');
});

test('classifies auth failed from HTTP authorization statuses', () => {
  assert.equal(classifyConnectionFailure({ status: 401 }).reason, 'auth_failed');
  assert.equal(classifyConnectionFailure({ response: { status: 403 } }).reason, 'auth_failed');
});

test('classifies rate limited from HTTP 429', () => {
  const classification = classifyConnectionFailure({ status: 429 });

  assert.equal(classification.reason, 'rate_limited');
  assert.equal(classification.category, 'token');
});

test('classifies network offline from explicit input flag', () => {
  const classification = classifyConnectionFailure({ offline: true });

  assert.equal(classification.reason, 'network_offline');
  assert.equal(classification.category, 'network');
  assert.equal(classification.recoverable, true);
});

test('classifies network timeout from timeout errors and HTTP timeout statuses', () => {
  assert.equal(classifyConnectionFailure({ name: 'TimeoutError' }).reason, 'network_timeout');
  assert.equal(classifyConnectionFailure({ name: 'AbortError' }).reason, 'network_timeout');
  assert.equal(classifyConnectionFailure({ status: 408 }).reason, 'network_timeout');
  assert.equal(classifyConnectionFailure({ status: 504 }).reason, 'network_timeout');
});

test('classifies audio capture timeout by context', () => {
  const classification = classifyConnectionFailure({ name: 'AbortError', context: 'microphone capture' });

  assert.equal(classification.reason, 'audio_capture_failed');
  assert.equal(classification.category, 'audio_device');
});

test('classifies provider unavailable from provider HTTP statuses', () => {
  assert.equal(classifyConnectionFailure({ status: 502, context: 'provider' }).reason, 'provider_unavailable');
  assert.equal(classifyConnectionFailure({ status: 503, context: 'gemini' }).reason, 'provider_unavailable');
  assert.equal(classifyConnectionFailure({ status: 504, context: 'live provider' }).reason, 'provider_unavailable');
});

test('classifies unexpected close from explicit reason', () => {
  const classification = classifyConnectionFailure({ reason: 'unexpected_close', code: 'auth_failed' });

  assert.equal(classification.reason, 'unexpected_close');
  assert.equal(classification.category, 'provider');
});

test('generic unexpected close remains unexpected close', () => {
  const classification = classifyConnectionFailure({
    reason: 'unexpected_close',
    rawEvent: { reason: 'provider closed', code: 1011 }
  });

  assert.equal(classification.reason, 'unexpected_close');
  assert.equal(classification.category, 'provider');
});

test('classifies user stop from explicit reason', () => {
  const classification = classifyConnectionFailure('user_stop');

  assert.equal(classification.reason, 'user_stop');
  assert.equal(classification.category, 'user_intent');
  assert.equal(classification.recoverable, false);
});

test('classifies cleanup failed from explicit reason', () => {
  const classification = classifyConnectionFailure({ reason: 'cleanup_failed' });

  assert.equal(classification.reason, 'cleanup_failed');
  assert.equal(classification.category, 'cleanup');
  assert.equal(classification.recoverable, false);
});

test('falls back to unknown error', () => {
  const classification = classifyConnectionFailure({ name: 'UnmappedError', message: 'raw failure' });

  assert.equal(classification.reason, 'unknown_error');
  assert.equal(classification.category, 'unknown');
});

test('explicit reason takes priority over inferred mapping', () => {
  const classification = classifyConnectionFailure({
    reason: 'token_expired',
    offline: true,
    status: 401,
    name: 'NotAllowedError'
  });

  assert.equal(classification.reason, 'token_expired');
});

test('requires fresh token for token and new-session failures', () => {
  assert.equal(requiresFreshToken(classifyConnectionFailure('token_expired')), true);
  assert.equal(requiresFreshToken(classifyConnectionFailure('unexpected_close')), true);
  assert.equal(requiresFreshToken(classifyConnectionFailure('live_connect_failed')), true);
  assert.equal(requiresFreshToken(classifyConnectionFailure('permission_denied')), false);
});

test('token expired requires fresh token without user action or stop recovery', () => {
  const classification = classifyConnectionFailure('token_expired');

  assert.equal(classification.recoverable, true);
  assert.equal(requiresFreshToken(classification), true);
  assert.equal(requiresUserAction(classification), false);
  assert.equal(shouldStopRecovery(classification), false);
});

test('stops recovery for terminal failures', () => {
  assert.equal(shouldStopRecovery(classifyConnectionFailure('user_stop')), true);
  assert.equal(shouldStopRecovery(classifyConnectionFailure('cleanup_failed')), true);
  assert.equal(shouldStopRecovery(classifyConnectionFailure('auth_failed')), true);
  assert.equal(shouldStopRecovery(classifyConnectionFailure('network_timeout')), false);
});

test('safeMessage does not include raw token, secret, or stack content', () => {
  const classification = classifyConnectionFailure({
    name: 'UnknownProviderError',
    message: 'token abc123 secret GEMINI_API_KEY at stack line'
  });

  assert.equal(classification.reason, 'unknown_error');
  assert.equal(classification.safeMessage.includes('abc123'), false);
  assert.equal(classification.safeMessage.includes('secret'), false);
  assert.equal(classification.safeMessage.includes('GEMINI_API_KEY'), false);
  assert.equal(classification.safeMessage.includes('stack'), false);
});

test('token expired safeMessage does not include raw token or stack content', () => {
  const classification = classifyConnectionFailure({
    rawError: new Error('token expired raw-token-abc123 at Provider.stack')
  });

  assert.equal(classification.reason, 'token_expired');
  assert.equal(classification.safeMessage.includes('raw-token-abc123'), false);
  assert.equal(classification.safeMessage.includes('Provider.stack'), false);
  assert.equal(classification.safeMessage.includes('token expired raw'), false);
});

test('provider error is not misclassified as token expired', () => {
  const classification = classifyConnectionFailure({
    reason: 'provider_error',
    rawError: new Error('The provider request expired unexpectedly')
  });

  assert.equal(classification.reason, 'provider_error');
  assert.equal(classification.category, 'provider');
});
