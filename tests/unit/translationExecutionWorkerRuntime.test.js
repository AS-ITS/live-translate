import assert from 'node:assert/strict';
import test from 'node:test';
import { createTranslationExecutionWorkerRuntime } from '../../src/infrastructure/translationExecutionWorkerRuntime.js';

test('runtime starts stopped', () => {
  const runtime = createTranslationExecutionWorkerRuntime({
    translationExecutionWorker: worker(),
    translationExecutionQueue: queue(['job-1']),
    scheduler: createFakeScheduler()
  });

  assert.equal(runtime.isRunning(), false);
});

test('start schedules polling', () => {
  const scheduler = createFakeScheduler();
  const runtime = createTranslationExecutionWorkerRuntime({
    translationExecutionWorker: worker(),
    translationExecutionQueue: queue(['job-1']),
    scheduler,
    pollIntervalMs: 25
  });

  runtime.start();

  assert.equal(runtime.isRunning(), true);
  assert.equal(scheduler.pendingCount(), 1);
  assert.deepEqual(scheduler.setCalls, [25]);
});

test('polling calls processNext', async () => {
  const calls = [];
  const scheduler = createFakeScheduler();
  const runtime = createTranslationExecutionWorkerRuntime({
    translationExecutionWorker: worker({ calls }),
    translationExecutionQueue: queue(['job-1']),
    scheduler,
    pollIntervalMs: 25
  });

  runtime.start();
  await scheduler.runNext();

  assert.deepEqual(calls, ['processNext']);
});

test('stop clears scheduled polling', () => {
  const scheduler = createFakeScheduler();
  const runtime = createTranslationExecutionWorkerRuntime({
    translationExecutionWorker: worker(),
    translationExecutionQueue: queue(['job-1']),
    scheduler
  });

  runtime.start();
  runtime.stop();

  assert.equal(runtime.isRunning(), false);
  assert.equal(scheduler.pendingCount(), 0);
  assert.equal(scheduler.clearCalls.length, 1);
});

test('repeated start does not create a second polling loop', () => {
  const scheduler = createFakeScheduler();
  const runtime = createTranslationExecutionWorkerRuntime({
    translationExecutionWorker: worker(),
    translationExecutionQueue: queue(['job-1']),
    scheduler
  });

  runtime.start();
  runtime.start();
  runtime.start();

  assert.equal(runtime.isRunning(), true);
  assert.equal(scheduler.pendingCount(), 1);
  assert.equal(scheduler.setCalls.length, 1);
});

test('stop before start is safe and remains stopped', () => {
  const scheduler = createFakeScheduler();
  const runtime = createTranslationExecutionWorkerRuntime({
    translationExecutionWorker: worker(),
    translationExecutionQueue: queue(['job-1']),
    scheduler
  });

  runtime.stop();

  assert.equal(runtime.isRunning(), false);
  assert.equal(scheduler.pendingCount(), 0);
  assert.equal(scheduler.clearCalls.length, 0);
});

test('repeated stop is safe', () => {
  const scheduler = createFakeScheduler();
  const runtime = createTranslationExecutionWorkerRuntime({
    translationExecutionWorker: worker(),
    translationExecutionQueue: queue(['job-1']),
    scheduler
  });

  runtime.start();
  runtime.stop();
  runtime.stop();

  assert.equal(runtime.isRunning(), false);
  assert.equal(scheduler.pendingCount(), 0);
  assert.equal(scheduler.clearCalls.length, 1);
});

test('runtime can restart after stop', async () => {
  const calls = [];
  const scheduler = createFakeScheduler();
  const runtime = createTranslationExecutionWorkerRuntime({
    translationExecutionWorker: worker({ calls }),
    translationExecutionQueue: queue(['job-1']),
    scheduler,
    pollIntervalMs: 25
  });

  runtime.start();
  runtime.stop();
  runtime.start();
  await scheduler.runNext();

  assert.equal(runtime.isRunning(), true);
  assert.deepEqual(calls, ['processNext']);
  assert.deepEqual(scheduler.setCalls, [25, 25, 25]);
  assert.equal(scheduler.pendingCount(), 1);
});

test('worker processing does not reenter processNext', async () => {
  const calls = [];
  const gate = createDeferred();
  const scheduler = createFakeScheduler();
  const runtime = createTranslationExecutionWorkerRuntime({
    translationExecutionWorker: worker({
      async processNext() {
        calls.push('processNext');
        await gate.promise;
      }
    }),
    translationExecutionQueue: queue(['job-1']),
    scheduler
  });

  runtime.start();
  const firstPoll = scheduler.runNext();

  await Promise.resolve();
  assert.equal(calls.length, 1);
  assert.equal(scheduler.pendingCount(), 0);

  gate.resolve();
  await firstPoll;

  assert.equal(runtime.isRunning(), true);
  assert.equal(calls.length, 1);
  assert.equal(scheduler.pendingCount(), 1);
});

test('worker error is logged and runtime continues polling', async () => {
  const workerError = new Error('worker failed');
  const calls = [];
  const loggedErrors = [];
  const scheduler = createFakeScheduler();
  const runtime = createTranslationExecutionWorkerRuntime({
    translationExecutionWorker: worker({
      processNext() {
        calls.push('processNext');
        if (calls.length === 1) {
          throw workerError;
        }
      }
    }),
    translationExecutionQueue: queue(['job-1']),
    scheduler,
    logger(error) {
      loggedErrors.push(error);
    }
  });

  runtime.start();
  await scheduler.runNext();
  await scheduler.runNext();

  assert.deepEqual(loggedErrors, [workerError]);
  assert.deepEqual(calls, ['processNext', 'processNext']);
  assert.equal(scheduler.pendingCount(), 1);
});

test('worker error does not create an unhandled rejection', async () => {
  const workerError = new Error('worker failed');
  const unhandledRejections = [];
  const scheduler = createFakeScheduler();
  const runtime = createTranslationExecutionWorkerRuntime({
    translationExecutionWorker: worker({
      async processNext() {
        throw workerError;
      }
    }),
    translationExecutionQueue: queue(['job-1']),
    scheduler
  });
  function onUnhandledRejection(error) {
    unhandledRejections.push(error);
  }

  process.on('unhandledRejection', onUnhandledRejection);
  try {
    runtime.start();
    await scheduler.runNext();
    await Promise.resolve();

    assert.deepEqual(unhandledRejections, []);
  } finally {
    process.off('unhandledRejection', onUnhandledRejection);
  }
});

test('stop prevents future worker execution', async () => {
  const calls = [];
  const scheduler = createFakeScheduler();
  const runtime = createTranslationExecutionWorkerRuntime({
    translationExecutionWorker: worker({ calls }),
    translationExecutionQueue: queue(['job-1']),
    scheduler
  });

  runtime.start();
  runtime.stop();
  await scheduler.runAll();

  assert.deepEqual(calls, []);
  assert.equal(scheduler.pendingCount(), 0);
});

test('stop while worker is processing prevents the next poll', async () => {
  const calls = [];
  const gate = createDeferred();
  const scheduler = createFakeScheduler();
  const runtime = createTranslationExecutionWorkerRuntime({
    translationExecutionWorker: worker({
      async processNext() {
        calls.push('processNext');
        await gate.promise;
      }
    }),
    translationExecutionQueue: queue(['job-1']),
    scheduler
  });

  runtime.start();
  const firstPoll = scheduler.runNext();
  await Promise.resolve();

  runtime.stop();
  assert.equal(runtime.isRunning(), true);
  gate.resolve();
  await firstPoll;
  await scheduler.runAll();

  assert.equal(runtime.isRunning(), false);
  assert.deepEqual(calls, ['processNext']);
  assert.equal(scheduler.pendingCount(), 0);
});

test('stop lets in-flight work finish before runtime becomes stopped', async () => {
  const calls = [];
  const gate = createDeferred();
  const scheduler = createFakeScheduler();
  const runtime = createTranslationExecutionWorkerRuntime({
    translationExecutionWorker: worker({
      async processNext() {
        calls.push('processNext:start');
        await gate.promise;
        calls.push('processNext:finish');
      }
    }),
    translationExecutionQueue: queue(['job-1']),
    scheduler
  });

  runtime.start();
  const firstPoll = scheduler.runNext();
  await Promise.resolve();

  runtime.stop();

  assert.equal(runtime.isRunning(), true);
  assert.deepEqual(calls, ['processNext:start']);

  gate.resolve();
  await firstPoll;

  assert.equal(runtime.isRunning(), false);
  assert.deepEqual(calls, ['processNext:start', 'processNext:finish']);
  assert.equal(scheduler.pendingCount(), 0);
});

test('work enqueued after stop is not processed until restart', async () => {
  const processedJobs = [];
  const executionQueue = queue(['job-1']);
  const gate = createDeferred();
  const scheduler = createFakeScheduler();
  const runtime = createTranslationExecutionWorkerRuntime({
    translationExecutionWorker: worker({
      async processNext() {
        processedJobs.push(executionQueue.dequeue());
        await gate.promise;
      }
    }),
    translationExecutionQueue: executionQueue,
    scheduler,
    pollIntervalMs: 25
  });

  runtime.start();
  const firstPoll = scheduler.runNext();
  await Promise.resolve();

  runtime.stop();
  executionQueue.enqueue('job-2');
  gate.resolve();
  await firstPoll;
  await scheduler.runAll();

  assert.equal(runtime.isRunning(), false);
  assert.deepEqual(processedJobs, ['job-1']);
  assert.equal(executionQueue.size(), 1);

  runtime.start();
  await scheduler.runNext();

  assert.equal(runtime.isRunning(), true);
  assert.deepEqual(processedJobs, ['job-1', 'job-2']);
  assert.equal(executionQueue.isEmpty(), true);
});

test('empty queue keeps polling without executing worker', async () => {
  const calls = [];
  const scheduler = createFakeScheduler();
  const runtime = createTranslationExecutionWorkerRuntime({
    translationExecutionWorker: worker({ calls }),
    translationExecutionQueue: queue(),
    scheduler,
    pollIntervalMs: 25
  });

  runtime.start();
  await scheduler.runNext();
  await scheduler.runNext();
  await scheduler.runNext();

  assert.equal(runtime.isRunning(), true);
  assert.deepEqual(calls, []);
  assert.deepEqual(scheduler.setCalls, [25, 25, 25, 25]);
  assert.equal(scheduler.pendingCount(), 1);
});

test('queued work after empty poll is processed without restarting runtime', async () => {
  const processedJobs = [];
  const executionQueue = queue();
  const scheduler = createFakeScheduler();
  const runtime = createTranslationExecutionWorkerRuntime({
    translationExecutionWorker: worker({
      processNext() {
        processedJobs.push(executionQueue.dequeue());
      }
    }),
    translationExecutionQueue: executionQueue,
    scheduler,
    pollIntervalMs: 25
  });

  runtime.start();
  await scheduler.runNext();
  executionQueue.enqueue('job-1');
  await scheduler.runNext();

  assert.equal(runtime.isRunning(), true);
  assert.deepEqual(processedJobs, ['job-1']);
  assert.equal(executionQueue.isEmpty(), true);
  assert.equal(scheduler.pendingCount(), 1);
});

test('runtime processes multiple jobs in FIFO order without restart', async () => {
  const processedJobs = [];
  const executionQueue = queue(['job-1', 'job-2', 'job-3']);
  const scheduler = createFakeScheduler();
  const runtime = createTranslationExecutionWorkerRuntime({
    translationExecutionWorker: worker({
      processNext() {
        processedJobs.push(executionQueue.dequeue());
      }
    }),
    translationExecutionQueue: executionQueue,
    scheduler,
    pollIntervalMs: 25
  });

  runtime.start();
  await scheduler.runNext();
  await scheduler.runNext();
  await scheduler.runNext();

  assert.deepEqual(processedJobs, ['job-1', 'job-2', 'job-3']);
  assert.equal(executionQueue.isEmpty(), true);
  assert.equal(runtime.isRunning(), true);
  assert.equal(scheduler.pendingCount(), 1);
});

test('worker returns to waiting after processing queued work', async () => {
  const processedJobs = [];
  const executionQueue = queue(['job-1']);
  const scheduler = createFakeScheduler();
  const runtime = createTranslationExecutionWorkerRuntime({
    translationExecutionWorker: worker({
      processNext() {
        processedJobs.push(executionQueue.dequeue());
      }
    }),
    translationExecutionQueue: executionQueue,
    scheduler,
    pollIntervalMs: 25
  });

  runtime.start();
  await scheduler.runNext();
  await scheduler.runNext();

  assert.deepEqual(processedJobs, ['job-1']);
  assert.equal(executionQueue.isEmpty(), true);
  assert.equal(runtime.isRunning(), true);
  assert.equal(scheduler.pendingCount(), 1);
});

function worker(options = {}) {
  const calls = options.calls ?? [];
  return {
    async processNext() {
      if (typeof options.processNext === 'function') {
        return options.processNext();
      }

      calls.push('processNext');
      return { status: 'idle' };
    }
  };
}

function queue(jobs = []) {
  const entries = [...jobs];

  return {
    enqueue(job) {
      entries.push(job);
    },
    dequeue() {
      return entries.shift();
    },
    isEmpty() {
      return entries.length === 0;
    },
    size() {
      return entries.length;
    }
  };
}

function createFakeScheduler() {
  let nextHandle = 1;
  const scheduled = [];

  return {
    setCalls: [],
    clearCalls: [],

    set(callback, delayMs) {
      const entry = {
        handle: nextHandle,
        callback,
        active: true
      };
      nextHandle += 1;
      scheduled.push(entry);
      this.setCalls.push(delayMs);
      return entry.handle;
    },

    clear(handle) {
      this.clearCalls.push(handle);
      const entry = scheduled.find((candidate) => candidate.handle === handle);

      if (entry) {
        entry.active = false;
      }
    },

    pendingCount() {
      return scheduled.filter((entry) => entry.active).length;
    },

    async runNext() {
      const entry = scheduled.find((candidate) => candidate.active);

      if (!entry) {
        return undefined;
      }

      entry.active = false;
      return entry.callback();
    },

    async runAll() {
      while (this.pendingCount() > 0) {
        await this.runNext();
      }
    }
  };
}

function createDeferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });

  return {
    promise,
    resolve
  };
}
