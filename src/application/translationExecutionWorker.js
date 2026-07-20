import { TRANSLATION_REPOSITORY_METHODS } from '../domain/translation/translationRepository.js';
import {
  assertDurableTranslationExecutionQueueRepository,
  DURABLE_TRANSLATION_EXECUTION_QUEUE_ITEM_STATUSES
} from './translation/durableTranslationExecutionQueueRepository.js';
import { assertTranslationExecutionQueue } from './translation/translationExecutionQueue.js';

const IDLE_RESULT = Object.freeze({ status: 'idle' });
const EXECUTION_NOT_PROCESSABLE_REASON = 'execution_not_processable';

export function createTranslationExecutionWorker({
  translationExecutionQueue,
  translationRepository,
  translationExecutionRunner,
  durableTranslationExecutionQueueRepository,
  leaseDurationMs = 300000,
  leaseRenewalMs = 100000,
  clock = () => new Date().toISOString(),
  scheduler = defaultScheduler()
} = {}) {
  assertTranslationExecutionQueue(translationExecutionQueue);
  assertTranslationRepository(translationRepository);
  assertTranslationExecutionRunner(translationExecutionRunner);
  assertOptionalDurableQueueRepository(durableTranslationExecutionQueueRepository);
  assertLeaseConfiguration(leaseDurationMs, leaseRenewalMs, clock, scheduler);

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

      if (durableTranslationExecutionQueueRepository !== undefined) {
        await durableTranslationExecutionQueueRepository.claim(job.executionId, addLease(clock(), leaseDurationMs));
        await durableTranslationExecutionQueueRepository.updateStatus(
          job.executionId,
          DURABLE_TRANSLATION_EXECUTION_QUEUE_ITEM_STATUSES.PROCESSING
        );
      }

      const heartbeat = durableTranslationExecutionQueueRepository === undefined
        ? undefined
        : createLeaseHeartbeat({ durableRepository: durableTranslationExecutionQueueRepository, executionId: job.executionId, leaseDurationMs, leaseRenewalMs, clock, scheduler });
      heartbeat?.start();

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

      if (heartbeat !== undefined) {
        await heartbeat.stop();
      }

      if (heartbeat?.error === undefined && durableTranslationExecutionQueueRepository !== undefined) {
        const persistedExecution = await translationRepository.findExecutionById(job.executionId);
        assertFoundExecution(persistedExecution, job.executionId);

        if (isTerminalExecution(persistedExecution)) {
          await durableTranslationExecutionQueueRepository.acknowledge(job.executionId);
        }
      }

      if (runnerFailed) {
        throw runnerError;
      }

      if (heartbeat?.error !== undefined) throw heartbeat.error;

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

function assertLeaseConfiguration(leaseDurationMs, leaseRenewalMs, clock, scheduler) {
  if (!Number.isInteger(leaseDurationMs) || leaseDurationMs <= 0) throw new TypeError('leaseDurationMs must be a positive integer.');
  if (!Number.isInteger(leaseRenewalMs) || leaseRenewalMs <= 0 || leaseRenewalMs >= leaseDurationMs) throw new TypeError('leaseRenewalMs must be lower than leaseDurationMs.');
  if (typeof clock !== 'function') throw new TypeError('clock must be a function.');
  if (!scheduler || typeof scheduler.schedule !== 'function' || typeof scheduler.cancel !== 'function') throw new TypeError('scheduler is required.');
}

function addLease(now, leaseDurationMs) {
  const timestamp = new Date(now).getTime();
  if (Number.isNaN(timestamp)) throw new TypeError('clock must return an ISO-8601 UTC string.');
  return new Date(timestamp + leaseDurationMs).toISOString();
}

function createLeaseHeartbeat({ durableRepository, executionId, leaseDurationMs, leaseRenewalMs, clock, scheduler }) {
  let handle;
  let stopped = false;
  let inFlight;
  let error;
  const heartbeat = {
    get error() { return error; },
    start() { scheduleNext(); },
    async stop() {
      stopped = true;
      if (handle !== undefined) scheduler.cancel(handle);
      if (inFlight !== undefined) await inFlight;
    }
  };
  function scheduleNext() {
    if (!stopped && error === undefined) handle = scheduler.schedule(run, leaseRenewalMs);
  }
  function run() {
    handle = undefined;
    if (stopped || error !== undefined) return;
    inFlight = durableRepository.renewLease(executionId, addLease(clock(), leaseDurationMs))
      .then(() => { inFlight = undefined; scheduleNext(); })
      .catch((renewalError) => { error = renewalError; inFlight = undefined; });
  }
  return heartbeat;
}

function defaultScheduler() {
  return { schedule(callback, delayMs) { return setTimeout(callback, delayMs); }, cancel(handle) { clearTimeout(handle); } };
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
