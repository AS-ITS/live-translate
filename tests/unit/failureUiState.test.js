import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyConnectionFailure } from '../../src/lib/connectionFailures.js';
import { failureUiStateForClassification } from '../../src/lib/failureUiState.js';

test('maps token_expired to expired manual recovery state', () => {
  const uiState = failureUiStateForClassification(classifyConnectionFailure('token_expired'));

  assert.equal(uiState.status, 'expired');
  assert.equal(uiState.message, '工作階段已過期。請開始新的工作階段。');
  assert.equal(uiState.shouldReconnect, false);
  assert.equal(uiState.startEnabled, true);
  assert.equal(uiState.stopVisible, false);
});

test('maps auth_failed to error manual recovery state', () => {
  const uiState = failureUiStateForClassification(classifyConnectionFailure('auth_failed'));

  assert.equal(uiState.status, 'error');
  assert.equal(uiState.statusLabel, '存取失敗');
  assert.equal(uiState.message, '存取失敗。請檢查存取權杖或設定。');
  assert.equal(uiState.shouldReconnect, false);
  assert.equal(uiState.startEnabled, true);
  assert.equal(uiState.stopVisible, false);
});

test('maps rate_limited to error manual recovery state', () => {
  const uiState = failureUiStateForClassification(classifyConnectionFailure('rate_limited'));

  assert.equal(uiState.status, 'error');
  assert.equal(uiState.statusLabel, '請求受限');
  assert.equal(uiState.message, '請求過於頻繁。請稍候再試。');
  assert.equal(uiState.shouldReconnect, false);
  assert.equal(uiState.startEnabled, true);
  assert.equal(uiState.stopVisible, false);
});

test('maps unexpected_close to controlled reconnect state', () => {
  const uiState = failureUiStateForClassification(classifyConnectionFailure('unexpected_close'));

  assert.equal(uiState.status, 'reconnecting');
  assert.equal(uiState.message, '');
  assert.equal(uiState.shouldReconnect, true);
  assert.equal(uiState.startEnabled, false);
  assert.equal(uiState.stopVisible, true);
});

test('maps provider_error to error state', () => {
  const uiState = failureUiStateForClassification(classifyConnectionFailure('provider_error'));

  assert.equal(uiState.status, 'error');
  assert.equal(uiState.message, '即時翻譯服務發生錯誤。請再試一次。');
  assert.equal(uiState.shouldReconnect, false);
  assert.equal(uiState.startEnabled, true);
  assert.equal(uiState.stopVisible, false);
});

test('maps unknown_error to error state', () => {
  const uiState = failureUiStateForClassification(classifyConnectionFailure('unknown_error'));

  assert.equal(uiState.status, 'error');
  assert.equal(uiState.message, '即時翻譯失敗。請再試一次。');
  assert.equal(uiState.shouldReconnect, false);
  assert.equal(uiState.startEnabled, true);
  assert.equal(uiState.stopVisible, false);
});

test('preserves classification safeMessage separately from manual message', () => {
  const classification = classifyConnectionFailure('token_expired');
  const uiState = failureUiStateForClassification(classification);

  assert.equal(uiState.safeMessage, classification.safeMessage);
  assert.notEqual(uiState.message, classification.safeMessage);
});

test('does not allow reconnect for manual recovery token failures', () => {
  for (const reason of ['token_expired', 'auth_failed', 'rate_limited']) {
    const uiState = failureUiStateForClassification(classifyConnectionFailure(reason));

    assert.equal(uiState.shouldReconnect, false);
  }
});

test('allows reconnect only for unexpected_close among covered reasons', () => {
  const reasons = ['token_expired', 'auth_failed', 'rate_limited', 'unexpected_close', 'provider_error', 'unknown_error'];
  const reconnectReasons = reasons.filter((reason) => {
    const uiState = failureUiStateForClassification(classifyConnectionFailure(reason));
    return uiState.shouldReconnect;
  });

  assert.deepEqual(reconnectReasons, ['unexpected_close']);
});
