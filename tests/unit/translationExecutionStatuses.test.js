import assert from 'node:assert/strict';
import test from 'node:test';
import { TranslationExecution } from '../../src/domain/translation/index.js';

test('queued execution cancels as an immutable terminal state while preserving metadata', () => {
  const queued = createExecution({
    providerKey: 'gemini',
    providerAttemptStatus: 'in_flight',
    providerAttemptedAt: 1100
  }).queue();
  const cancelled = queued.cancel(1200);

  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.completedAt, 1200);
  assert.equal(cancelled.failureInfo, null);
  assert.equal(cancelled.id, queued.id);
  assert.equal(cancelled.translationRequestId, queued.translationRequestId);
  assert.equal(cancelled.providerKey, queued.providerKey);
  assert.equal(cancelled.providerIdempotencyKey, queued.providerIdempotencyKey);
  assert.equal(cancelled.providerAttemptStatus, queued.providerAttemptStatus);
  assert.equal(cancelled.providerAttemptedAt, queued.providerAttemptedAt);
  assert.equal(cancelled.providerCompletedAt, queued.providerCompletedAt);
  assert.equal(cancelled.startedAt, queued.startedAt);
  assert.equal(Object.isFrozen(cancelled), true);
  assert.throws(() => {
    cancelled.completedAt = 1300;
  }, TypeError);
  assert.equal(queued.status, 'queued');
  assert.equal(queued.completedAt, null);
});

test('cancelled execution is terminal and cancellation rejects every non-queued status deterministically', () => {
  const created = createExecution();
  const queued = created.queue();
  const running = queued.start(1100);
  const completed = running.complete(1200);
  const failed = running.fail({ reason: 'provider_error' }, 1200);
  const cancelled = queued.cancel(1200);

  for (const execution of [created, running, completed, failed, cancelled]) {
    assert.throws(
      () => execution.cancel(1300),
      new RegExp(`status transition from ${execution.status} to cancelled is not allowed`)
    );
  }

  for (const status of ['queued', 'running', 'completed', 'failed', 'created']) {
    assert.throws(
      () => cancelled.transitionTo(status),
      new RegExp(`status transition from cancelled to ${status} is not allowed`)
    );
  }
});

test('cancelled execution requires a completion timestamp and does not accept failure information', () => {
  assert.throws(
    () => createExecution({ status: 'cancelled' }),
    /completedAt is required for cancelled execution/
  );
  assert.throws(
    () => createExecution({ status: 'cancelled', completedAt: 1200, failureInfo: { reason: 'cancelled' } }),
    /failureInfo is not allowed for cancelled execution/
  );
});

test('only failed executions are eligible for manual retry; a retry creates a new execution instead of rewriting the failed source', () => {
  const created = createExecution();
  const queued = created.queue();
  const running = queued.start(1100);
  const completed = running.complete(1200);
  const failed = running.fail({ reason: 'provider_error' }, 1200);
  const cancelled = queued.cancel(1200);

  assert.equal(failed.isManualRetryEligible(), true);
  for (const execution of [created, queued, running, completed, cancelled]) {
    assert.equal(execution.isManualRetryEligible(), false);
  }
});

function createExecution(overrides = {}) {
  return new TranslationExecution({
    id: 'execution-1',
    translationRequestId: 'request-1',
    startedAt: 1000,
    ...overrides
  });
}
