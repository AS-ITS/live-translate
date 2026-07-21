import assert from 'node:assert/strict';
import test from 'node:test';
import { createTranslationExecutionLeaseHeartbeat } from '../../src/application/translation/translationExecutionLeaseHeartbeat.js';

test('starts renewal only after the interval and schedules the next tick after success', async () => {
  const calls = [];
  const scheduler = fakeScheduler();
  const heartbeat = createHeartbeat({
    scheduler,
    renewClaim(executionId, claim, lease) {
      calls.push([executionId, claim, lease]);
    }
  });

  const running = heartbeat.start({ executionId: 'execution-1', claim: { leaseId: 'lease-1', fenceToken: 1 } });
  assert.deepEqual(calls, []);
  assert.deepEqual(scheduler.delays, [100]);

  await scheduler.runNext();
  assert.deepEqual(calls, [[
    'execution-1',
    { leaseId: 'lease-1' },
    { now: '2026-07-21T00:00:00.000Z', leaseExpiresAt: '2026-07-21T00:05:00.000Z' }
  ]]);
  assert.deepEqual(scheduler.delays, [100, 100]);

  await running.stop();
});

test('does not overlap renewal, waits for in-flight renewal on stop, and ignores cleared callbacks', async () => {
  const scheduler = fakeScheduler();
  let releaseRenewal;
  const renewal = new Promise((resolve) => { releaseRenewal = resolve; });
  let renewals = 0;
  const running = createHeartbeat({
    scheduler,
    renewClaim() {
      renewals += 1;
      return renewal;
    }
  }).start({ executionId: 'execution-1', claim: { leaseId: 'lease-1' } });

  const firstCallback = scheduler.callbacks[0];
  const firstTick = firstCallback();
  await Promise.resolve();
  assert.equal(renewals, 1);
  const stopped = running.stop();
  assert.equal(scheduler.cleared.length, 0);
  releaseRenewal();
  await firstTick;
  await stopped;
  assert.equal(scheduler.callbacks.length, 1);

  await firstCallback();
  assert.equal(renewals, 1);
  await running.stop();
});

test('records renewal failure and stops future scheduling without unrelated durable operations', async () => {
  const scheduler = fakeScheduler();
  const renewalError = new Error('renewal failed');
  const calls = [];
  const running = createHeartbeat({
    scheduler,
    renewClaim() {
      calls.push('renew');
      throw renewalError;
    }
  }).start({ executionId: 'execution-1', claim: { leaseId: 'lease-1' } });

  await scheduler.runNext();
  assert.deepEqual(calls, ['renew']);
  assert.strictEqual(running.getRenewalError(), renewalError);
  assert.equal(scheduler.delays.length, 1);
  await running.stop();
});

test('rejects invalid heartbeat dependencies deterministically', () => {
  for (const options of [
    { leaseDurationMs: 0 },
    { leaseRenewalMs: 0 },
    { leaseDurationMs: 100, leaseRenewalMs: 100 },
    { clock: null },
    { scheduler: {} }
  ]) {
    assert.throws(() => createHeartbeat(options), TypeError);
  }
});

function createHeartbeat({
  scheduler = fakeScheduler(),
  renewClaim = () => undefined,
  leaseDurationMs = 300000,
  leaseRenewalMs = 100,
  clock = () => '2026-07-21T00:00:00.000Z'
} = {}) {
  return createTranslationExecutionLeaseHeartbeat({
    durableTranslationExecutionQueueRepository: durableRepository({ renewClaim }),
    leaseDurationMs,
    leaseRenewalMs,
    clock,
    scheduler
  });
}

function durableRepository({ renewClaim }) {
  return {
    enqueue() {}, dequeue() {}, peek() {}, list() {}, size() {}, clear() {}, updateStatus() {},
    acknowledge() {}, acknowledgeClaim() {}, contains() {}, claim() {}, renewClaim() { return renewClaim(...arguments); },
    assertClaimActive() {},
    requeueExpiredProcessing() {}
  };
}

function fakeScheduler() {
  const callbacks = [];
  const active = new Set();
  const delays = [];
  const cleared = [];
  return {
    callbacks,
    delays,
    cleared,
    set(callback, delayMs) {
      callbacks.push(callback);
      delays.push(delayMs);
      active.add(callback);
      return callback;
    },
    clear(handle) {
      cleared.push(handle);
      active.delete(handle);
    },
    async runNext() {
      const callback = callbacks.find((candidate) => active.has(candidate));
      if (callback !== undefined) {
        active.delete(callback);
        await callback();
      }
    }
  };
}
