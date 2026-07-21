import { TRANSLATION_REPOSITORY_METHODS } from '../domain/translation/translationRepository.js';
import { randomUUID } from 'node:crypto';
import { assertDurableTranslationExecutionQueueRepository } from './translation/durableTranslationExecutionQueueRepository.js';
import { assertTranslationExecutionQueue } from './translation/translationExecutionQueue.js';
import { createTranslationExecutionLeaseHeartbeat } from './translation/translationExecutionLeaseHeartbeat.js';

const IDLE_RESULT = Object.freeze({ status: 'idle' });
const EXECUTION_NOT_PROCESSABLE_REASON = 'execution_not_processable';
const DEFAULT_LEASE_HEARTBEAT_SCHEDULER = Object.freeze({
  set(callback, delayMs) { return setTimeout(callback, delayMs); },
  clear(handle) { clearTimeout(handle); }
});

export function createTranslationExecutionWorker({
  translationExecutionQueue,
  translationRepository,
  translationExecutionRunner,
  durableTranslationExecutionQueueRepository,
  leaseDurationMs = 300000,
  leaseRenewalMs = 100000,
  clock = () => new Date().toISOString(),
  leaseIdFactory = randomUUID,
  leaseHeartbeatScheduler = DEFAULT_LEASE_HEARTBEAT_SCHEDULER
} = {}) {
  assertTranslationExecutionQueue(translationExecutionQueue);
  assertTranslationRepository(translationRepository);
  assertTranslationExecutionRunner(translationExecutionRunner);
  assertOptionalDurableQueueRepository(durableTranslationExecutionQueueRepository);
  if (durableTranslationExecutionQueueRepository !== undefined) {
    assertLeaseConfiguration(leaseDurationMs, leaseRenewalMs, clock, leaseIdFactory, leaseHeartbeatScheduler);
  }

  return Object.freeze({
    async processNext() {
      const job = await translationExecutionQueue.dequeue();

      if (job === null || job === undefined) {
        return IDLE_RESULT;
      }

      const execution = await translationRepository.findExecutionById(job.executionId);
      assertFoundExecution(execution, job.executionId);

      const request = await translationRepository.findRequestById(job.requestId);
      assertFoundRequest(request, job.requestId);

      if (execution.status !== 'queued') {
        return {
          processed: false,
          reason: EXECUTION_NOT_PROCESSABLE_REASON,
          executionId: job.executionId,
          status: execution.status
        };
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
              })
        });
      } catch (error) {
        runnerError = error;
        runnerFailed = true;
      } finally {
        if (leaseHeartbeat !== undefined) await leaseHeartbeat.stop();
      }

      const renewalError = leaseHeartbeat?.getRenewalError();

      if (durableTranslationExecutionQueueRepository !== undefined && renewalError === undefined) {
        const persistedExecution = await translationRepository.findExecutionById(job.executionId);
        assertFoundExecution(persistedExecution, job.executionId);

        if (isTerminalExecution(persistedExecution)) {
          try {
            await durableTranslationExecutionQueueRepository.acknowledgeClaim(job.executionId, {
              leaseId: claimedDurableItem.leaseId,
              fenceToken: claimedDurableItem.fenceToken
            });
          } catch (error) {
            if (!runnerFailed) throw error;
          }
        }
      }

      if (runnerFailed) {
        throw runnerError;
      }

      if (renewalError !== undefined) throw renewalError;

      return {
        status: 'processed',
        executionId: job.executionId
      };
    }
  });
}

function isTerminalExecution(execution) {
  return execution.status === 'completed' || execution.status === 'failed';
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
