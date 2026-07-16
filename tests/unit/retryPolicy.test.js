import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyConnectionFailure } from '../../src/lib/connectionFailures.js';
import {
  createRetryState,
  nextRetryDecision,
  recordRetryAttempt,
  resetRetryState
} from '../../src/lib/retryPolicy.js';
import { createRetryPolicy } from '../../src/application/translation/retryPolicy.js';

test('first retry is allowed for recoverable failure', () => {
  const state = createRetryState();
  const decision = nextRetryDecision(state, classifyConnectionFailure('unexpected_close'));

  assert.equal(decision.shouldRetry, true);
  assert.equal(decision.delayMs, 750);
  assert.equal(decision.attempt, 1);
  assert.equal(decision.maxAttempts, 3);
});

test('exponential backoff increases after recorded attempts', () => {
  let state = createRetryState();
  const first = nextRetryDecision(state, classifyConnectionFailure('network_timeout'));
  state = recordRetryAttempt(state, first, 1000);

  const second = nextRetryDecision(state, classifyConnectionFailure('network_timeout'));

  assert.equal(first.delayMs, 750);
  assert.equal(second.delayMs, 1500);
  assert.equal(second.attempt, 2);
});

test('maxDelay caps exponential backoff', () => {
  const state = { ...createRetryState(), attempts: 1 };
  const decision = nextRetryDecision(state, classifyConnectionFailure('network_timeout'), {
    baseDelayMs: 5000,
    maxDelayMs: 8000
  });

  assert.equal(decision.shouldRetry, true);
  assert.equal(decision.delayMs, 8000);
});

test('maxAttempts is enforced', () => {
  const state = { ...createRetryState(), attempts: 3 };
  const decision = nextRetryDecision(state, classifyConnectionFailure('unexpected_close'));

  assert.equal(decision.shouldRetry, false);
  assert.equal(decision.stopReason, 'max_attempts_exceeded');
});

test('recoveryWindow is enforced', () => {
  const state = { ...createRetryState(), attempts: 1, firstAttemptAt: 1000 };
  const decision = nextRetryDecision(state, classifyConnectionFailure('unexpected_close'), {
    now: 31001,
    recoveryWindowMs: 30000
  });

  assert.equal(decision.shouldRetry, false);
  assert.equal(decision.stopReason, 'recovery_window_exceeded');
});

test('offline returns paused and record does not increment attempt', () => {
  const state = createRetryState();
  const decision = nextRetryDecision(state, classifyConnectionFailure('network_offline'));
  const nextState = recordRetryAttempt(state, decision, 1000);

  assert.equal(decision.shouldRetry, false);
  assert.equal(decision.paused, true);
  assert.equal(decision.stopReason, 'offline');
  assert.equal(nextState.attempts, 0);
  assert.equal(nextState.firstAttemptAt, null);
});

test('user_stop does not retry', () => {
  const decision = nextRetryDecision(createRetryState(), classifyConnectionFailure('user_stop'));

  assert.equal(decision.shouldRetry, false);
  assert.equal(decision.stopReason, 'user_stop');
});

test('cleanup_failed does not retry', () => {
  const decision = nextRetryDecision(createRetryState(), classifyConnectionFailure('cleanup_failed'));

  assert.equal(decision.shouldRetry, false);
  assert.equal(decision.stopReason, 'cleanup_failed');
});

test('auth_failed does not retry', () => {
  const decision = nextRetryDecision(createRetryState(), classifyConnectionFailure('auth_failed'));

  assert.equal(decision.shouldRetry, false);
  assert.equal(decision.stopReason, 'auth_failed');
});

test('rate_limited does not immediately retry', () => {
  const decision = nextRetryDecision(createRetryState(), classifyConnectionFailure('rate_limited'));

  assert.equal(decision.shouldRetry, false);
  assert.equal(decision.paused, false);
  assert.equal(decision.stopReason, 'rate_limited');
});

test('token_expired retries', () => {
  const decision = nextRetryDecision(createRetryState(), classifyConnectionFailure('token_expired'));

  assert.equal(decision.shouldRetry, true);
});

test('unexpected_close retries', () => {
  const decision = nextRetryDecision(createRetryState(), classifyConnectionFailure('unexpected_close'));

  assert.equal(decision.shouldRetry, true);
});

test('live_connect_failed retries', () => {
  const decision = nextRetryDecision(createRetryState(), classifyConnectionFailure('live_connect_failed'));

  assert.equal(decision.shouldRetry, true);
});

test('unknown_error retries within limit', () => {
  const decision = nextRetryDecision(createRetryState(), classifyConnectionFailure('unknown_error'));

  assert.equal(decision.shouldRetry, true);
  assert.equal(decision.reason, 'unknown_error');
});

test('jitter is deterministic with injected random', () => {
  const highJitter = nextRetryDecision(createRetryState(), classifyConnectionFailure('network_timeout'), {
    baseDelayMs: 1000,
    jitterRatio: 0.2,
    random: () => 1
  });
  const lowJitter = nextRetryDecision(createRetryState(), classifyConnectionFailure('network_timeout'), {
    baseDelayMs: 1000,
    jitterRatio: 0.2,
    random: () => 0
  });

  assert.equal(highJitter.delayMs, 1100);
  assert.equal(lowJitter.delayMs, 900);
});

test('recordRetryAttempt updates attempts and timestamps for retry decisions', () => {
  const state = createRetryState();
  const decision = nextRetryDecision(state, classifyConnectionFailure('unexpected_close'));
  const nextState = recordRetryAttempt(state, decision, 1234);

  assert.equal(nextState.attempts, 1);
  assert.equal(nextState.firstAttemptAt, 1234);
  assert.equal(nextState.lastAttemptAt, 1234);
});

test('reset clears retry state', () => {
  const state = {
    ...createRetryState(),
    attempts: 2,
    firstAttemptAt: 1000,
    lastAttemptAt: 2000
  };
  const reset = resetRetryState(state);

  assert.equal(reset.attempts, 0);
  assert.equal(reset.firstAttemptAt, null);
  assert.equal(reset.lastAttemptAt, null);
});

test('application retry policy is immutable', () => {
  const policy = createRetryPolicy();

  assert.equal(Object.isFrozen(policy), true);
  assert.deepEqual(Object.keys(policy), ['maxRetries', 'delayStrategy', 'canRetry', 'nextDelay']);
});

test('application retry policy defaults maxRetries to zero', () => {
  const policy = createRetryPolicy();

  assert.equal(policy.maxRetries, 0);
});

test('application retry policy default rejects retry after first failed attempt', () => {
  const policy = createRetryPolicy();

  assert.equal(policy.canRetry(1), false);
});

test('application retry policy nextDelay returns zero', () => {
  const policy = createRetryPolicy();

  assert.equal(policy.nextDelay(1), 0);
});

test('application retry policy custom retry count controls retry allowance', () => {
  const policy = createRetryPolicy({ maxRetries: 2 });

  assert.equal(policy.canRetry(1), true);
  assert.equal(policy.canRetry(2), true);
  assert.equal(policy.canRetry(3), false);
});

test('application retry policy accepts placeholder delay strategy configuration', () => {
  const strategy = () => 125;
  const policy = createRetryPolicy({ delayStrategy: strategy });

  assert.strictEqual(policy.delayStrategy, strategy);
  assert.equal(policy.nextDelay(1), 0);
});

test('application retry policy rejects invalid configuration', () => {
  assert.throws(() => createRetryPolicy(null), /retryPolicy options must be an object/);
  assert.throws(() => createRetryPolicy({ maxRetries: -1 }), /retryPolicy\.maxRetries/);
  assert.throws(() => createRetryPolicy({ maxRetries: 1.5 }), /retryPolicy\.maxRetries/);
  assert.throws(() => createRetryPolicy({ delayStrategy: 100 }), /retryPolicy\.delayStrategy/);
});

test('application retry policy rejects invalid attempts', () => {
  const policy = createRetryPolicy();

  assert.throws(() => policy.canRetry(0), /retryPolicy attempt must be a positive integer/);
  assert.throws(() => policy.canRetry(1.5), /retryPolicy attempt must be a positive integer/);
});
