import assert from 'node:assert/strict';
import test from 'node:test';
import { createTranslationExecutionWorkerRuntime } from '../../src/infrastructure/translationExecutionWorkerRuntime.js';

test('start schedules polling', () => {
  const scheduler = createFakeScheduler();
  const runtime = createTranslationExecutionWorkerRuntime({
    translationExecutionWorker: worker(),
    scheduler,
    pollIntervalMs: 25
  });

  runtime.start();

  assert.equal(scheduler.pendingCount(), 1);
  assert.deepEqual(scheduler.setCalls, [25]);
});

test('polling calls processNext', async () => {
  const calls = [];
  const scheduler = createFakeScheduler();
  const runtime = createTranslationExecutionWorkerRuntime({
    translationExecutionWorker: worker({ calls }),
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
    scheduler
  });

  runtime.start();
  runtime.stop();

  assert.equal(scheduler.pendingCount(), 0);
  assert.equal(scheduler.clearCalls.length, 1);
});

test('repeated start does not create a second polling loop', () => {
  const scheduler = createFakeScheduler();
  const runtime = createTranslationExecutionWorkerRuntime({
    translationExecutionWorker: worker(),
    scheduler
  });

  runtime.start();
  runtime.start();
  runtime.start();

  assert.equal(scheduler.pendingCount(), 1);
  assert.equal(scheduler.setCalls.length, 1);
});

test('repeated stop is safe', () => {
  const scheduler = createFakeScheduler();
  const runtime = createTranslationExecutionWorkerRuntime({
    translationExecutionWorker: worker(),
    scheduler
  });

  runtime.start();
  runtime.stop();
  runtime.stop();

  assert.equal(scheduler.pendingCount(), 0);
  assert.equal(scheduler.clearCalls.length, 1);
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
    scheduler
  });

  runtime.start();
  const firstPoll = scheduler.runNext();

  await Promise.resolve();
  assert.equal(calls.length, 1);
  assert.equal(scheduler.pendingCount(), 0);

  gate.resolve();
  await firstPoll;

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
    scheduler
  });

  runtime.start();
  const firstPoll = scheduler.runNext();
  await Promise.resolve();

  runtime.stop();
  gate.resolve();
  await firstPoll;
  await scheduler.runAll();

  assert.deepEqual(calls, ['processNext']);
  assert.equal(scheduler.pendingCount(), 0);
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
