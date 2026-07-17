import { assertTranslationExecutionQueue } from '../application/translation/translationExecutionQueue.js';

const DEFAULT_POLL_INTERVAL_MS = 1000;

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
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  scheduler = DEFAULT_SCHEDULER,
  logger
} = {}) {
  assertTranslationExecutionWorker(translationExecutionWorker);
  assertTranslationExecutionQueue(translationExecutionQueue);
  assertPollIntervalMs(pollIntervalMs);
  assertScheduler(scheduler);
  assertLogger(logger);

  let isStarted = false;
  let isProcessing = false;
  let timerHandle;

  function start() {
    if (isStarted) {
      return;
    }

    isStarted = true;
    scheduleNextPoll();
  }

  function stop() {
    isStarted = false;
    clearScheduledPoll();
  }

  function isRunning() {
    return isStarted || isProcessing;
  }

  function scheduleNextPoll() {
    if (!isStarted || timerHandle !== undefined) {
      return;
    }

    timerHandle = scheduler.set(processNextPoll, pollIntervalMs);
  }

  function clearScheduledPoll() {
    if (timerHandle === undefined) {
      return;
    }

    scheduler.clear(timerHandle);
    timerHandle = undefined;
  }

  async function processNextPoll() {
    timerHandle = undefined;

    if (!isStarted || isProcessing) {
      scheduleNextPoll();
      return;
    }

    isProcessing = true;

    try {
      if (!translationExecutionQueue.isEmpty()) {
        await translationExecutionWorker.processNext();
      }
    } catch (error) {
      logRuntimeError(error);
    } finally {
      isProcessing = false;
      scheduleNextPoll();
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

  return Object.freeze({
    start,
    stop,
    isRunning
  });
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
