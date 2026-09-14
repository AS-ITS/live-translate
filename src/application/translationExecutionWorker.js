import { TRANSLATION_REPOSITORY_METHODS } from '../domain/translation/translationRepository.js';
import { randomUUID } from 'node:crypto';
import { assertDurableTranslationExecutionQueueRepository } from './translation/durableTranslationExecutionQueueRepository.js';
import { assertTranslationExecutionQueue } from './translation/translationExecutionQueue.js';
import { createTranslationExecutionLeaseHeartbeat } from './translation/translationExecutionLeaseHeartbeat.js';
import {
  assertTranslationExecutionMetrics,
  createNoopTranslationExecutionMetrics,
  TRANSLATION_EXECUTION_METRIC_NAMES
} from './translation/translationExecutionMetrics.js';
import { setRequestUser } from '../../server/requestIdentity.js';
import { OBSERVABILITY_METRIC_NAMES } from './observability/observabilityMetricRegistry.js';

const IDLE_RESULT = Object.freeze({ status: 'idle' });
const EXECUTION_NOT_PROCESSABLE_REASON = 'execution_not_processable';
const PROVIDER_ATTEMPT_IN_FLIGHT_REASON = 'provider_attempt_in_flight';
const DEFAULT_LEASE_HEARTBEAT_SCHEDULER = Object.freeze({
  set(callback, delayMs) { return setTimeout(callback, delayMs); },
  clear(handle) { clearTimeout(handle); }
});

export function createTranslationExecutionWorker({
  translationExecutionQueue,
  translationRepository,
  translationExecutionRunner,
  durableTranslationExecutionQueueRepository,
  translationExecutionRetryPolicy,
  translationExecutionRetryErrorClassifier,
  retryRandom = Math.random,
  metrics = createNoopTranslationExecutionMetrics(),
  leaseDurationMs = 300000,
  leaseRenewalMs = 100000,
  clock = () => new Date().toISOString(),
  leaseIdFactory = randomUUID,
  leaseHeartbeatScheduler = DEFAULT_LEASE_HEARTBEAT_SCHEDULER
  , observabilityMetrics
} = {}) {
  assertTranslationExecutionQueue(translationExecutionQueue);
  assertTranslationRepository(translationRepository);
  assertTranslationExecutionRunner(translationExecutionRunner);
  assertTranslationExecutionMetrics(metrics);
  assertOptionalDurableQueueRepository(durableTranslationExecutionQueueRepository);
  if (durableTranslationExecutionQueueRepository !== undefined) {
    assertLeaseConfiguration(leaseDurationMs, leaseRenewalMs, clock, leaseIdFactory, leaseHeartbeatScheduler);
    assertOptionalRetryDependencies(translationExecutionRetryPolicy, translationExecutionRetryErrorClassifier, retryRandom);
  }

  return Object.freeze({
    async processNext() {
      const job = await translationExecutionQueue.dequeue();

      if (job === null || job === undefined) {
        safeSetGauge(metrics, TRANSLATION_EXECUTION_METRIC_NAMES.QUEUE_DEPTH, translationExecutionQueue.size());
        safeObsGauge(observabilityMetrics, OBSERVABILITY_METRIC_NAMES.QUEUE_DEPTH, translationExecutionQueue.size());
        return IDLE_RESULT;
      }
      if (job.ownerUserId) setRequestUser({ id: job.ownerUserId, kind: 'worker' });
      safeSetGauge(metrics, TRANSLATION_EXECUTION_METRIC_NAMES.QUEUE_DEPTH, translationExecutionQueue.size());
      safeObsGauge(observabilityMetrics, OBSERVABILITY_METRIC_NAMES.QUEUE_DEPTH, translationExecutionQueue.size());
      const executionStartedAt = epochMs(typeof clock === 'function' ? clock() : Date.now());
      safeObsCounter(observabilityMetrics, OBSERVABILITY_METRIC_NAMES.EXECUTION_STARTED);

      const execution = await translationRepository.findExecutionById(job.executionId);
      assertFoundExecution(execution, job.executionId);

      const request = await translationRepository.findRequestById(job.requestId);
      assertFoundRequest(request, job.requestId);

      if (execution.status === 'cancelled') {
        safeIncrement(metrics, TRANSLATION_EXECUTION_METRIC_NAMES.CANCELLED_TOTAL);
        safeObsCounter(observabilityMetrics, OBSERVABILITY_METRIC_NAMES.EXECUTION_CANCELLED);
        return acknowledgeCancelledExecution({
          durableTranslationExecutionQueueRepository,
          job,
          clock,
          leaseIdFactory,
          leaseDurationMs
        });
      }

      if (execution.status !== 'queued') {
        safeIncrement(metrics, TRANSLATION_EXECUTION_METRIC_NAMES.SKIPPED_TOTAL);
        safeObsCounter(observabilityMetrics, OBSERVABILITY_METRIC_NAMES.EXECUTION_SKIPPED);
        return {
          processed: false,
          reason: EXECUTION_NOT_PROCESSABLE_REASON,
          executionId: job.executionId,
          status: execution.status
        };
      }

      if (execution.providerAttemptStatus === 'in_flight') {
        if (typeof translationExecutionRunner.canReplayInFlight === 'function'
          && await translationExecutionRunner.canReplayInFlight(execution)) {
          // A guaranteed provider may safely replay the same idempotency key.
        } else {
        return {
          processed: false,
          reason: PROVIDER_ATTEMPT_IN_FLIGHT_REASON,
          executionId: job.executionId,
          status: execution.status
        };
        }
      }

      let claimedDurableItem;
      if (durableTranslationExecutionQueueRepository !== undefined) {
        claimedDurableItem = await durableTranslationExecutionQueueRepository.claim(
          job.executionId,
          createLease({ clock, leaseIdFactory, leaseDurationMs })
        );
      }

      const leaseHeartbeat = durableTranslationExecutionQueueRepository !== undefined
        ? createTranslationExecutionLeaseHeartbeat({
            durableTranslationExecutionQueueRepository,
            leaseDurationMs,
            leaseRenewalMs,
            clock,
            scheduler: leaseHeartbeatScheduler
          }).start({
            executionId: job.executionId,
            claim: {
              leaseId: claimedDurableItem.leaseId,
              fenceToken: claimedDurableItem.fenceToken
            }
          })
        : undefined;

      let runnerError;
      let runnerFailed = false;
      const coordinateQueueRetry = durableTranslationExecutionQueueRepository !== undefined
        && translationExecutionRetryPolicy !== undefined;
      try {
        await runTranslationExecution(translationExecutionRunner, {
          execution,
          request,
          ...(claimedDurableItem === undefined
            ? {}
            : {
                executionFence: {
                  executionId: job.executionId,
                  leaseId: claimedDurableItem.leaseId,
                  fenceToken: claimedDurableItem.fenceToken
                }
              }),
          ...(coordinateQueueRetry ? { deferProviderFailure: true } : {})
        });
      } catch (error) {
        runnerError = error;
        runnerFailed = true;
      } finally {
        if (leaseHeartbeat !== undefined) await leaseHeartbeat.stop();
      }

      const renewalError = leaseHeartbeat?.getRenewalError();
      let retryQueued = false;

      if (coordinateQueueRetry && runnerFailed && renewalError === undefined) {
        const persistedExecution = await translationRepository.findExecutionById(job.executionId);
        assertFoundExecution(persistedExecution, job.executionId);

        if (!isTerminalExecution(persistedExecution)) {
          const classification = translationExecutionRetryErrorClassifier.classify(runnerError);
          const attempt = claimedDurableItem.attempt + 1;
          if (classification.retryable && translationExecutionRetryPolicy.canRetry(attempt)) {
            const delayMs = translationExecutionRetryPolicy.getNextDelayMs(attempt, { random: retryRandom });
            await durableTranslationExecutionQueueRepository.retryClaim(job.executionId, {
              leaseId: claimedDurableItem.leaseId,
              fenceToken: claimedDurableItem.fenceToken,
              attempt,
              availableAt: createAvailableAt(clock, delayMs),
              lastFailure: createLastFailure(runnerError, classification.reason)
            });
            if (persistedExecution.status === 'running') {
              await translationRepository.updateTranslationExecution(persistedExecution.resumeAfterExpiredLease());
            }
            retryQueued = true;
          } else if (persistedExecution.status === 'running') {
            const failedAt = clock();
            await translationRepository.updateTranslationExecution(
              persistedExecution.fail(createLastFailure(runnerError, classification.reason), failedAt)
            );
          }
        }
      }

      if (durableTranslationExecutionQueueRepository !== undefined && renewalError === undefined && !retryQueued) {
        const persistedExecution = await translationRepository.findExecutionById(job.executionId);
        assertFoundExecution(persistedExecution, job.executionId);

        if (persistedExecution.status === 'failed' && runnerFailed
          && typeof durableTranslationExecutionQueueRepository.transferClaimToDeadLetter === 'function') {
          try {
            await durableTranslationExecutionQueueRepository.transferClaimToDeadLetter(job.executionId, {
              leaseId: claimedDurableItem.leaseId,
              fenceToken: claimedDurableItem.fenceToken,
              failedAt: persistedExecution.completedAt,
              failure: persistedExecution.failureInfo,
              ...(persistedExecution.providerKey === undefined ? {} : { providerKey: persistedExecution.providerKey }),
              providerMetadata: { providerKey: persistedExecution.providerKey ?? null },
              executionMetadata: {
                translationRequestId: persistedExecution.translationRequestId,
                startedAt: persistedExecution.startedAt,
                targetLanguageCode: request.targetLanguageCode
              }
            });
            safeIncrement(metrics, TRANSLATION_EXECUTION_METRIC_NAMES.DLQ_TRANSFER_TOTAL);
          } catch (error) {
            // The provider error remains authoritative; recovery retries only this transfer.
            safeIncrement(metrics, TRANSLATION_EXECUTION_METRIC_NAMES.ACKNOWLEDGEMENT_ERROR_TOTAL);
          }
        } else if (isTerminalExecution(persistedExecution)) {
          try {
            await durableTranslationExecutionQueueRepository.acknowledgeClaim(job.executionId, {
              leaseId: claimedDurableItem.leaseId,
              fenceToken: claimedDurableItem.fenceToken
            });
          } catch (error) {
            safeIncrement(metrics, TRANSLATION_EXECUTION_METRIC_NAMES.ACKNOWLEDGEMENT_ERROR_TOTAL);
            if (!runnerFailed) throw error;
          }
        }
      }

      if (runnerFailed) {
        if (retryQueued) {
          safeIncrement(metrics, TRANSLATION_EXECUTION_METRIC_NAMES.RETRY_TOTAL);
          safeObsCounter(observabilityMetrics, OBSERVABILITY_METRIC_NAMES.EXECUTION_RETRY);
          return { status: 'retried', executionId: job.executionId };
        }
        safeIncrement(metrics, TRANSLATION_EXECUTION_METRIC_NAMES.FAILED_TOTAL);
        safeObsCounter(observabilityMetrics, OBSERVABILITY_METRIC_NAMES.EXECUTION_FAILURE);
        safeObsLatency(observabilityMetrics, OBSERVABILITY_METRIC_NAMES.EXECUTION_LATENCY, Math.max(0, epochMs(typeof clock === 'function' ? clock() : Date.now()) - executionStartedAt));
        throw runnerError;
      }

      if (renewalError !== undefined) {
        safeIncrement(metrics, TRANSLATION_EXECUTION_METRIC_NAMES.LEASE_ERROR_TOTAL);
        throw renewalError;
      }

      safeIncrement(metrics, TRANSLATION_EXECUTION_METRIC_NAMES.PROCESSED_TOTAL);
      safeObsCounter(observabilityMetrics, OBSERVABILITY_METRIC_NAMES.EXECUTION_COMPLETED);
      safeObsLatency(observabilityMetrics, OBSERVABILITY_METRIC_NAMES.EXECUTION_LATENCY, Math.max(0, epochMs(typeof clock === 'function' ? clock() : Date.now()) - executionStartedAt));
      safeMarkSuccess(metrics);
      safeSetGauge(metrics, TRANSLATION_EXECUTION_METRIC_NAMES.QUEUE_DEPTH, translationExecutionQueue.size());

      return {
        status: 'processed',
        executionId: job.executionId
      };
    }
  });
}

function safeIncrement(metrics, name) {
  try {
    metrics.increment(name);
  } catch {
    // Metrics must never change queue behavior.
  }
}

function safeSetGauge(metrics, name, value) {
  try {
    metrics.setGauge(name, value);
  } catch {
    // Metrics must never change queue behavior.
  }
}

function safeMarkSuccess(metrics) {
  try {
    metrics.markSuccess();
  } catch {
    // Metrics must never change queue behavior.
  }
}

function safeObsCounter(observability, name, amount = 1, labels) {
  try { observability?.recordCounter?.(name, amount, labels); } catch { /* observability is best effort */ }
}

function safeObsLatency(observability, name, value, labels) {
  try { observability?.recordLatency?.(name, value, labels); } catch { /* observability is best effort */ }
}

function safeObsGauge(observability, name, value, labels) {
  try { observability?.setGauge?.(name, value, labels); } catch { /* observability is best effort */ }
}

function epochMs(value) {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function isTerminalExecution(execution) {
  return execution.status === 'completed' || execution.status === 'failed' || execution.status === 'cancelled';
}

async function acknowledgeCancelledExecution({
  durableTranslationExecutionQueueRepository,
  job,
  clock,
  leaseIdFactory,
  leaseDurationMs
}) {
  if (durableTranslationExecutionQueueRepository !== undefined) {
    const claimedItem = await durableTranslationExecutionQueueRepository.claim(
      job.executionId,
      createLease({ clock, leaseIdFactory, leaseDurationMs })
    );
    await durableTranslationExecutionQueueRepository.acknowledgeClaim(job.executionId, {
      leaseId: claimedItem.leaseId,
      fenceToken: claimedItem.fenceToken
    });
  }

  return {
    status: 'cancelled',
    executionId: job.executionId
  };
}

function assertLeaseConfiguration(leaseDurationMs, leaseRenewalMs, clock, leaseIdFactory, leaseHeartbeatScheduler) {
  if (!Number.isInteger(leaseDurationMs) || leaseDurationMs <= 0) throw new TypeError('leaseDurationMs must be a positive integer.');
  if (!Number.isInteger(leaseRenewalMs) || leaseRenewalMs <= 0) throw new TypeError('leaseRenewalMs must be a positive integer.');
  if (leaseRenewalMs >= leaseDurationMs) throw new TypeError('leaseRenewalMs must be lower than leaseDurationMs.');
  if (typeof clock !== 'function') throw new TypeError('clock must be a function.');
  if (typeof leaseIdFactory !== 'function') throw new TypeError('leaseIdFactory must be a function.');
  if (leaseHeartbeatScheduler === null || typeof leaseHeartbeatScheduler !== 'object') {
    throw new TypeError('leaseHeartbeatScheduler must be an object.');
  }
  for (const methodName of ['set', 'clear']) {
    if (typeof leaseHeartbeatScheduler[methodName] !== 'function') {
      throw new TypeError(`leaseHeartbeatScheduler.${methodName} must be a function.`);
    }
  }
}

function assertOptionalRetryDependencies(policy, classifier, retryRandom) {
  if (policy === undefined && classifier === undefined) return;
  if (!policy || typeof policy.canRetry !== 'function' || typeof policy.getNextDelayMs !== 'function') {
    throw new TypeError('translationExecutionRetryPolicy must provide canRetry and getNextDelayMs.');
  }
  if (!classifier || typeof classifier.classify !== 'function') {
    throw new TypeError('translationExecutionRetryErrorClassifier.classify must be a function.');
  }
  if (typeof retryRandom !== 'function') throw new TypeError('retryRandom must be a function.');
}

function createAvailableAt(clock, delayMs) {
  const now = clock();
  assertIsoUtcTimestamp(now, 'clock must return an ISO-8601 UTC string.');
  return new Date(new Date(now).getTime() + delayMs).toISOString();
}

function createLastFailure(error, reason) {
  const failure = { reason };
  if (typeof error?.message === 'string') failure.message = error.message;
  if (typeof error?.code === 'string') failure.code = error.code;
  return failure;
}

function createLease({ clock, leaseIdFactory, leaseDurationMs }) {
  const claimedAt = clock();
  assertIsoUtcTimestamp(claimedAt, 'clock must return an ISO-8601 UTC string.');

  const leaseId = leaseIdFactory();
  if (typeof leaseId !== 'string' || leaseId.trim().length === 0) {
    throw new TypeError('leaseIdFactory must return a non-empty string.');
  }

  const timestamp = new Date(claimedAt).getTime();
  return {
    leaseId,
    claimedAt,
    leaseExpiresAt: new Date(timestamp + leaseDurationMs).toISOString()
  };
}

function assertIsoUtcTimestamp(value, message) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new TypeError(message);
  }

  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime()) || timestamp.toISOString() !== value) {
    throw new TypeError(message);
  }
}

function assertOptionalDurableQueueRepository(durableTranslationExecutionQueueRepository) {
  if (durableTranslationExecutionQueueRepository !== undefined) {
    assertDurableTranslationExecutionQueueRepository(durableTranslationExecutionQueueRepository);
  }
}

function assertTranslationRepository(translationRepository) {
  if (!translationRepository) {
    throw new TypeError('translationRepository is required.');
  }

  for (const methodName of TRANSLATION_REPOSITORY_METHODS) {
    if (typeof translationRepository[methodName] !== 'function') {
      throw new TypeError(`translationRepository.${methodName} must be a function.`);
    }
  }
}

function assertTranslationExecutionRunner(translationExecutionRunner) {
  if (!translationExecutionRunner || typeof translationExecutionRunner !== 'object') {
    throw new TypeError('translationExecutionRunner is required.');
  }

  if (
    typeof translationExecutionRunner.run !== 'function' &&
    typeof translationExecutionRunner.execute !== 'function'
  ) {
    throw new TypeError('translationExecutionRunner.run must be a function.');
  }
}

function runTranslationExecution(translationExecutionRunner, input) {
  if (typeof translationExecutionRunner.run === 'function') {
    return translationExecutionRunner.run(input);
  }

  return translationExecutionRunner.execute(input);
}

function assertFoundExecution(execution, executionId) {
  if (execution === null || execution === undefined) {
    throw new Error(`TranslationExecution ${executionId} was not found`);
  }
}

function assertFoundRequest(request, requestId) {
  if (request === null || request === undefined) {
    throw new Error(`TranslationRequest ${requestId} was not found`);
  }
}
