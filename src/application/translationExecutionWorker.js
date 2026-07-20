import { TRANSLATION_REPOSITORY_METHODS } from '../domain/translation/translationRepository.js';
import { randomUUID } from 'node:crypto';
import { assertDurableTranslationExecutionQueueRepository } from './translation/durableTranslationExecutionQueueRepository.js';
import { assertTranslationExecutionQueue } from './translation/translationExecutionQueue.js';

const IDLE_RESULT = Object.freeze({ status: 'idle' });
const EXECUTION_NOT_PROCESSABLE_REASON = 'execution_not_processable';

export function createTranslationExecutionWorker({
  translationExecutionQueue,
  translationRepository,
  translationExecutionRunner,
  durableTranslationExecutionQueueRepository,
  leaseDurationMs = 300000,
  clock = () => new Date().toISOString(),
  leaseIdFactory = randomUUID
} = {}) {
  assertTranslationExecutionQueue(translationExecutionQueue);
  assertTranslationRepository(translationRepository);
  assertTranslationExecutionRunner(translationExecutionRunner);
  assertOptionalDurableQueueRepository(durableTranslationExecutionQueueRepository);
  if (durableTranslationExecutionQueueRepository !== undefined) {
    assertLeaseConfiguration(leaseDurationMs, clock, leaseIdFactory);
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

      let runnerError;
      let runnerFailed = false;
      try {
        await runTranslationExecution(translationExecutionRunner, {
          execution,
          request
        });
      } catch (error) {
        runnerError = error;
        runnerFailed = true;
      }

      if (durableTranslationExecutionQueueRepository !== undefined) {
        const persistedExecution = await translationRepository.findExecutionById(job.executionId);
        assertFoundExecution(persistedExecution, job.executionId);

        if (isTerminalExecution(persistedExecution)) {
          try {
            await durableTranslationExecutionQueueRepository.acknowledgeClaim(job.executionId, {
              leaseId: claimedDurableItem.leaseId
            });
          } catch (error) {
            if (!runnerFailed) throw error;
          }
        }
      }

      if (runnerFailed) {
        throw runnerError;
      }

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

function assertLeaseConfiguration(leaseDurationMs, clock, leaseIdFactory) {
  if (!Number.isInteger(leaseDurationMs) || leaseDurationMs <= 0) throw new TypeError('leaseDurationMs must be a positive integer.');
  if (typeof clock !== 'function') throw new TypeError('clock must be a function.');
  if (typeof leaseIdFactory !== 'function') throw new TypeError('leaseIdFactory must be a function.');
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
