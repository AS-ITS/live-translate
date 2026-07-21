import { assertDurableTranslationExecutionQueueRepository } from './durableTranslationExecutionQueueRepository.js';

export function createTranslationExecutionLeaseHeartbeat({
  durableTranslationExecutionQueueRepository,
  leaseDurationMs,
  leaseRenewalMs,
  clock,
  scheduler
} = {}) {
  assertDurableTranslationExecutionQueueRepository(durableTranslationExecutionQueueRepository);
  assertPositiveInteger(leaseDurationMs, 'leaseDurationMs');
  assertPositiveInteger(leaseRenewalMs, 'leaseRenewalMs');
  if (leaseRenewalMs >= leaseDurationMs) {
    throw new TypeError('leaseRenewalMs must be lower than leaseDurationMs.');
  }
  if (typeof clock !== 'function') throw new TypeError('clock must be a function.');
  assertScheduler(scheduler);

  return Object.freeze({
    start({ executionId, claim } = {}) {
      assertNonEmptyString(executionId, 'executionId must be a non-empty string.');
      if (claim === null || typeof claim !== 'object' || Array.isArray(claim)) {
        throw new TypeError('claim must be an object.');
      }
      assertNonEmptyString(claim.leaseId, 'claim.leaseId must be a non-empty string.');

      let stopped = false;
      let timer;
      let inFlight;
      let renewalError;

      const scheduleNext = () => {
        if (!stopped) timer = scheduler.set(runTick, leaseRenewalMs);
      };

      const runTick = async () => {
        timer = undefined;
        if (stopped || inFlight !== undefined) return;

        const now = clock();
        assertIsoUtcTimestamp(now, 'clock must return an ISO-8601 UTC string.');
        const leaseExpiresAt = new Date(new Date(now).getTime() + leaseDurationMs).toISOString();
        inFlight = Promise.resolve().then(() => durableTranslationExecutionQueueRepository.renewClaim(
          executionId,
          { leaseId: claim.leaseId },
          { now, leaseExpiresAt }
        ));

        try {
          await inFlight;
        } catch (error) {
          renewalError = error;
          stopped = true;
        } finally {
          inFlight = undefined;
          scheduleNext();
        }
      };

      scheduleNext();

      return Object.freeze({
        async stop() {
          stopped = true;
          if (timer !== undefined) {
            scheduler.clear(timer);
            timer = undefined;
          }
          if (inFlight !== undefined) await inFlight.catch(() => undefined);
        },
        getRenewalError() {
          return renewalError;
        }
      });
    }
  });
}

function assertPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
}

function assertScheduler(scheduler) {
  if (scheduler === null || typeof scheduler !== 'object' || Array.isArray(scheduler)) {
    throw new TypeError('scheduler must be an object.');
  }
  for (const methodName of ['set', 'clear']) {
    if (typeof scheduler[methodName] !== 'function') {
      throw new TypeError(`scheduler.${methodName} must be a function.`);
    }
  }
}

function assertNonEmptyString(value, message) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(message);
}

function assertIsoUtcTimestamp(value, message) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new TypeError(message);
  }
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime()) || timestamp.toISOString() !== value) throw new TypeError(message);
}
