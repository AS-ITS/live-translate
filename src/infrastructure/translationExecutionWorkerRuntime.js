import { assertTranslationExecutionQueue } from '../application/translation/translationExecutionQueue.js';
import {
  assertTranslationExecutionMetrics,
  createNoopTranslationExecutionMetrics,
  TRANSLATION_EXECUTION_METRIC_NAMES
} from '../application/translation/translationExecutionMetrics.js';

const DEFAULT_POLL_INTERVAL_MS = 1000;
const PENDING_SCHEDULE = Symbol('pending_schedule');

const DEFAULT_SCHEDULER = Object.freeze({
  set(callback, delayMs) {
    return setTimeout(callback, delayMs);
  },

  clear(handle) {
    clearTimeout(handle);
  }
});

export function createTranslationExecutionWorkerRuntime({
  translationExecutionWorker,
  translationExecutionQueue,
  durableRepository,
  clock = () => new Date().toISOString(),
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  scheduler = DEFAULT_SCHEDULER,
  logger,
  metrics = createNoopTranslationExecutionMetrics()
} = {}) {
  assertTranslationExecutionWorker(translationExecutionWorker);
  assertTranslationExecutionQueue(translationExecutionQueue);
  assertOptionalDurableRepository(durableRepository);
  if (typeof clock !== 'function') throw new TypeError('clock must be a function.');
  assertPollIntervalMs(pollIntervalMs);
  assertScheduler(scheduler);
  assertLogger(logger);
  assertTranslationExecutionMetrics(metrics);

  let isStarted = false;
  let isProcessing = false;
  let timerHandle;

  function start() {
    if (isStarted) {
      return;
    }

    isStarted = true;
    scheduleNextPoll(false);
  }

  function stop() {
    isStarted = false;
    clearScheduledPoll();
  }

  function isRunning() {
    return isStarted || isProcessing;
  }

  function wake() {
    if (!isStarted || isProcessing) {
      return;
    }

    clearScheduledPoll();
    timerHandle = scheduler.set(processNextPoll, 0);
  }

  function scheduleNextPoll(resolveAvailableAt) {
    if (!isStarted || timerHandle !== undefined) {
      return;
    }

    if (!resolveAvailableAt || durableRepository === undefined) {
      timerHandle = scheduler.set(processNextPoll, pollIntervalMs);
      return;
    }

    const scheduleToken = PENDING_SCHEDULE;
    timerHandle = scheduleToken;
    Promise.resolve(durableRepository.nextAvailableAt(clock())).then((availableAt) => {
      if (!isStarted || timerHandle !== scheduleToken) return;
      const delayMs = availableAt === null
        ? pollIntervalMs
        : Math.min(pollIntervalMs, Math.max(0, new Date(availableAt).getTime() - new Date(clock()).getTime()));
      timerHandle = scheduler.set(processNextPoll, delayMs);
    }).catch((error) => {
      logRuntimeError(error);
      if (isStarted && timerHandle === scheduleToken) timerHandle = scheduler.set(processNextPoll, pollIntervalMs);
    });
  }

  function clearScheduledPoll() {
    if (timerHandle === undefined) {
      return;
    }

    if (timerHandle !== PENDING_SCHEDULE) scheduler.clear(timerHandle);
    timerHandle = undefined;
  }

  async function processNextPoll() {
    timerHandle = undefined;

    if (!isStarted || isProcessing) {
      scheduleNextPoll(true);
      return;
    }

    isProcessing = true;

    try {
      if (translationExecutionQueue.size() === 0 && durableRepository !== undefined) {
        const items = await durableRepository.listAvailable(clock());
        for (const item of items) {
          await translationExecutionQueue.enqueue({ executionId: item.executionId, requestId: item.requestId, ...(item.ownerUserId ? { ownerUserId: item.ownerUserId } : {}) });
        }
      }
      if (translationExecutionQueue.size() > 0) {
        await translationExecutionWorker.processNext();
      }
      safeSetGauge(metrics, TRANSLATION_EXECUTION_METRIC_NAMES.QUEUE_DEPTH, translationExecutionQueue.size());
    } catch (error) {
      logRuntimeError(error);
    } finally {
      isProcessing = false;
      scheduleNextPoll(true);
    }
  }

  function logRuntimeError(error) {
    if (typeof logger !== 'function') {
      return;
    }

    try {
      logger(error);
    } catch {
      // Runtime logging must not break polling.
    }
  }

  async function runOnce({ limit = 1 } = {}) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new TypeError('limit must be a positive integer.');
    }
    if (isProcessing) {
      return { processed: 0, busy: true };
    }

    isProcessing = true;
    let processed = 0;
    try {
      if (durableRepository !== undefined) {
        const availableItems = await durableRepository.listAvailable(clock());
        for (const item of availableItems.slice(0, limit)) {
          if (translationExecutionQueue.size() >= limit) break;
          await translationExecutionQueue.enqueue({
            executionId: item.executionId,
            requestId: item.requestId,
            ...(item.ownerUserId ? { ownerUserId: item.ownerUserId } : {})
          });
        }
      }

      while (processed < limit && translationExecutionQueue.size() > 0) {
        await translationExecutionWorker.processNext();
        processed += 1;
      }
      safeSetGauge(metrics, TRANSLATION_EXECUTION_METRIC_NAMES.QUEUE_DEPTH, translationExecutionQueue.size());
      return { processed, busy: false };
    } finally {
      isProcessing = false;
    }
  }

return Object.freeze({
    start,
    stop,
    isRunning,
    wake,
    runOnce
  });
}

function safeSetGauge(metrics, name, value) {
  try {
    metrics.setGauge(name, value);
  } catch {
    // Metrics must never break worker polling.
  }
}

function assertTranslationExecutionWorker(translationExecutionWorker) {
  if (!translationExecutionWorker || typeof translationExecutionWorker !== 'object') {
    throw new TypeError('translationExecutionWorker is required.');
  }

  if (typeof translationExecutionWorker.processNext !== 'function') {
    throw new TypeError('translationExecutionWorker.processNext must be a function.');
  }
}

function assertPollIntervalMs(pollIntervalMs) {
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 0) {
    throw new TypeError('pollIntervalMs must be a non-negative integer.');
  }
}

function assertScheduler(scheduler) {
  if (!scheduler || typeof scheduler !== 'object') {
    throw new TypeError('scheduler is required.');
  }

  if (typeof scheduler.set !== 'function') {
    throw new TypeError('scheduler.set must be a function.');
  }

  if (typeof scheduler.clear !== 'function') {
    throw new TypeError('scheduler.clear must be a function.');
  }
}

function assertLogger(logger) {
  if (logger !== undefined && typeof logger !== 'function') {
    throw new TypeError('logger must be a function.');
  }
}

function assertOptionalDurableRepository(repository) {
  if (repository === undefined) return;
  if (!repository || typeof repository.listAvailable !== 'function' || typeof repository.nextAvailableAt !== 'function') {
    throw new TypeError('durableRepository must provide listAvailable and nextAvailableAt.');
  }
}
