import assert from 'node:assert/strict';
import test from 'node:test';
import { createTranslationExecutionWorker } from '../../src/application/translationExecutionWorker.js';
import { TranslationExecution, TranslationRequest } from '../../src/domain/translation/index.js';
import { TRANSLATION_REPOSITORY_METHODS } from '../../src/domain/translation/translationRepository.js';
import { createFakeDurableTranslationExecutionQueueRepository } from '../../src/infrastructure/fakeDurableTranslationExecutionQueueRepository.js';
import { createFakeDeadLetterQueueRepository } from '../../src/infrastructure/fakeDeadLetterQueueRepository.js';
import { createInMemoryTranslationExecutionQueue } from '../../src/infrastructure/inMemoryTranslationExecutionQueue.js';

test('empty queue returns idle', async () => {
  const worker = createTranslationExecutionWorker(workerDependencies({ translationExecutionQueue: queue() }));

  assert.deepEqual(await worker.processNext(), { status: 'idle' });
});

test('empty queue does not call repository or runner', async () => {
  const calls = [];
  const worker = createTranslationExecutionWorker(workerDependencies({ calls, translationExecutionQueue: queue() }));

  await worker.processNext();

  assert.deepEqual(calls, []);
});

test('dequeue once processes only one job', async () => {
  const calls = [];
  const queue = createInMemoryTranslationExecutionQueue();
  queue.enqueue({ executionId: 'execution-1', requestId: 'request-1' });
  queue.enqueue({ executionId: 'execution-2', requestId: 'request-2' });
  const worker = createTranslationExecutionWorker(workerDependencies({ calls, translationExecutionQueue: queue }));

  const result = await worker.processNext();

  assert.deepEqual(result, { status: 'processed', executionId: 'execution-1' });
  assert.deepEqual(calls.map((call) => call[0]), ['findExecutionById', 'findRequestById', 'runner.run']);
  assert.equal(queue.size(), 1);
  assert.deepEqual(queue.dequeue(), { executionId: 'execution-2', requestId: 'request-2' });
});

test('repository is queried with execution and request identifiers', async () => {
  const calls = [];
  const worker = createTranslationExecutionWorker(workerDependencies({ calls }));

  await worker.processNext();

  assert.deepEqual(calls[0], ['findExecutionById', 'execution-1']);
  assert.deepEqual(calls[1], ['findRequestById', 'request-1']);
});

test('runner.run is called once with loaded execution and request', async () => {
  const calls = [];
  const execution = translationExecution({ id: 'execution-loaded' });
  const request = translationRequest({ id: 'request-loaded' });
  const worker = createTranslationExecutionWorker(
    workerDependencies({
      calls,
      translationExecutionQueue: queue([{ executionId: 'execution-loaded', requestId: 'request-loaded' }]),
      translationRepository: repository({ execution, request })
    })
  );

  const result = await worker.processNext();

  const runnerCalls = calls.filter((call) => call[0] === 'runner.run');
  assert.equal(runnerCalls.length, 1);
  assert.deepEqual(result, { status: 'processed', executionId: 'execution-loaded' });
  assert.strictEqual(runnerCalls[0][1].execution, execution);
  assert.strictEqual(runnerCalls[0][1].request, request);
});

for (const status of ['created', 'running', 'completed', 'failed']) {
  test(`${status} execution is skipped before durable claim or runner execution`, async () => {
    const calls = [];
    const worker = createTranslationExecutionWorker(
      workerDependencies({
        calls,
        translationRepository: repository({ calls, execution: executionWithStatus(status) }),
        durableTranslationExecutionQueueRepository: durableRepository({ calls })
      })
    );

    assert.deepEqual(await worker.processNext(), {
      processed: false,
      reason: 'execution_not_processable',
      executionId: 'execution-1',
      status
    });
    assert.deepEqual(calls.map((call) => call[0]), ['findExecutionById', 'findRequestById']);
  });
}

test('queued execution with an in_flight provider attempt is skipped without reclaim replay', async () => {
  const calls = [];
  const worker = createTranslationExecutionWorker(
    workerDependencies({
      calls,
      translationRepository: repository({
        calls,
        execution: translationExecution({
          providerAttemptStatus: 'in_flight',
          providerAttemptedAt: '2026-07-20T00:00:00.000Z'
        })
      }),
      durableTranslationExecutionQueueRepository: durableRepository({ calls })
    })
  );

  assert.deepEqual(await worker.processNext(), {
    processed: false,
    reason: 'provider_attempt_in_flight',
    executionId: 'execution-1',
    status: 'queued'
  });
  assert.deepEqual(calls.map((call) => call[0]), ['findExecutionById', 'findRequestById']);
});

test('durable queue claim is persisted before runner starts', async () => {
  const calls = [];
  const worker = createTranslationExecutionWorker(
    workerDependencies({
      calls,
      durableTranslationExecutionQueueRepository: durableRepository({ calls }),
      clock: () => '2026-07-20T00:00:00.000Z',
      leaseIdFactory: () => 'lease-1',
      leaseDurationMs: 300000
    })
  );

  await worker.processNext();

  assert.deepEqual(calls.map((call) => call[0]), [
    'findExecutionById',
    'findRequestById',
    'durable.claim',
    'runner.run',
    'findExecutionById'
  ]);
  assert.deepEqual(calls[2], ['durable.claim', 'execution-1', {
    leaseId: 'lease-1',
    claimedAt: '2026-07-20T00:00:00.000Z',
    leaseExpiresAt: '2026-07-20T00:05:00.000Z'
  }]);
});

test('durable worker propagates the claimed lease and fence token to runner', async () => {
  let runnerInput;
  const worker = createTranslationExecutionWorker(workerDependencies({
    durableTranslationExecutionQueueRepository: durableRepository({
      claim() { return { leaseId: 'lease-1', fenceToken: 7 }; }
    }),
    translationExecutionRunner: { run(input) { runnerInput = input; } },
    clock: () => '2026-07-20T00:00:00.000Z',
    leaseIdFactory: () => 'lease-1'
  }));

  await worker.processNext();

  assert.deepEqual(runnerInput.executionFence, {
    executionId: 'execution-1',
    leaseId: 'lease-1',
    fenceToken: 7
  });
});

test('acknowledges after a successful runner reaches completed state', async () => {
  const calls = [];
  let persistedExecution = translationExecution();
  const worker = createTranslationExecutionWorker(
    workerDependencies({
      calls,
      translationExecutionRunner: {
        run() {
          calls.push(['runner.run']);
          persistedExecution = executionWithStatus('completed');
        }
      },
      translationRepository: repository({ calls, execution: () => persistedExecution }),
      leaseIdFactory: () => 'lease-1',
      durableTranslationExecutionQueueRepository: durableRepository({
        calls,
        acknowledgeClaim(executionId, claim) {
          calls.push(['durable.acknowledgeClaim', persistedExecution.status, executionId, claim]);
        }
      })
    })
  );

  await worker.processNext();

  assert.deepEqual(calls.map((call) => call[0]), [
    'findExecutionById',
    'findRequestById',
    'durable.claim',
    'runner.run',
    'findExecutionById',
    'durable.acknowledgeClaim'
  ]);
  assert.deepEqual(calls.at(-1), ['durable.acknowledgeClaim', 'completed', 'execution-1', { leaseId: 'lease-1', fenceToken: 1 }]);
});

test('durable queue claim failure propagates without running execution', async () => {
  const calls = [];
  const claimError = new Error('claim failed');
  const durableItem = {
    executionId: 'execution-1',
    requestId: 'request-1',
    enqueuedAt: '2026-07-17T08:00:00.000Z',
    status: 'queued'
  };
  const worker = createTranslationExecutionWorker(
    workerDependencies({
      calls,
      durableTranslationExecutionQueueRepository: durableRepository({
        calls,
        claim() {
          assert.equal(durableItem.status, 'queued');
          calls.push(['durable.claim', 'execution-1']);
          throw claimError;
        }
      })
    })
  );

  await assert.rejects(worker.processNext(), (error) => error === claimError);

  assert.deepEqual(calls.map((call) => call[0]), ['findExecutionById', 'findRequestById', 'durable.claim']);
  assert.equal(durableItem.status, 'queued');
});

test('durable worker renews a pending runner claim and acknowledges after heartbeat stops', async () => {
  const calls = [];
  const scheduler = fakeScheduler();
  let releaseRunner;
  let persistedExecution = translationExecution();
  const runnerPending = new Promise((resolve) => { releaseRunner = resolve; });
  const worker = createTranslationExecutionWorker(workerDependencies({
    calls,
    leaseDurationMs: 1000,
    leaseRenewalMs: 100,
    leaseHeartbeatScheduler: scheduler,
    clock: () => '2026-07-20T00:00:00.000Z',
    leaseIdFactory: () => 'lease-1',
    translationExecutionRunner: {
      run() {
        calls.push(['runner.run']);
        return runnerPending;
      }
    },
    translationRepository: repository({ calls, execution: () => persistedExecution }),
    durableTranslationExecutionQueueRepository: durableRepository({
      calls,
      renewClaim(executionId, claim, lease) {
        calls.push(['durable.renewClaim', executionId, claim, lease]);
      },
      acknowledgeClaim(executionId, claim) {
        calls.push(['durable.acknowledgeClaim', executionId, claim]);
      }
    })
  }));

  const processing = worker.processNext();
  await flushMicrotasks();
  await scheduler.runNext();
  assert.deepEqual(calls.find((call) => call[0] === 'durable.renewClaim'), [
    'durable.renewClaim',
    'execution-1',
    { leaseId: 'lease-1' },
    { now: '2026-07-20T00:00:00.000Z', leaseExpiresAt: '2026-07-20T00:00:01.000Z' }
  ]);

  persistedExecution = executionWithStatus('completed');
  releaseRunner();
  await processing;
  assert.equal(calls.filter((call) => call[0] === 'durable.acknowledgeClaim').length, 1);
  assert.equal(scheduler.activeCount(), 0);
});

test('renewal failure skips acknowledgement and preserves runner error precedence', async () => {
  const scheduler = fakeScheduler();
  const renewalError = new Error('renewal failed');
  const runnerError = new Error('runner failed');
  let releaseRunner;
  const runnerPending = new Promise((resolve) => { releaseRunner = resolve; });
  const calls = [];
  const worker = createTranslationExecutionWorker(workerDependencies({
    calls,
    leaseDurationMs: 1000,
    leaseRenewalMs: 100,
    leaseHeartbeatScheduler: scheduler,
    translationExecutionRunner: { run() { return runnerPending; } },
    durableTranslationExecutionQueueRepository: durableRepository({
      calls,
      renewClaim() { throw renewalError; }
    })
  }));

  const processing = worker.processNext();
  await flushMicrotasks();
  await scheduler.runNext();
  releaseRunner();
  await assert.rejects(processing, (error) => error === renewalError);
  assert.equal(calls.some((call) => call[0] === 'durable.acknowledgeClaim'), false);

  const failureScheduler = fakeScheduler();
  let rejectRunner;
  const failingRunner = new Promise((resolve, reject) => { rejectRunner = reject; });
  const failedWorker = createTranslationExecutionWorker(workerDependencies({
    leaseDurationMs: 1000,
    leaseRenewalMs: 100,
    leaseHeartbeatScheduler: failureScheduler,
    translationExecutionRunner: { run() { return failingRunner; } },
    durableTranslationExecutionQueueRepository: durableRepository({ renewClaim() { throw renewalError; } })
  }));
  const failedProcessing = failedWorker.processNext();
  await flushMicrotasks();
  await failureScheduler.runNext();
  rejectRunner(runnerError);
  await assert.rejects(failedProcessing, (error) => error === runnerError);
});

test('a processing durable item cannot be claimed by another active queue job', async () => {
  const durableRepository = createFakeDurableTranslationExecutionQueueRepository();
  const item = {
    executionId: 'execution-1',
    requestId: 'request-1',
    enqueuedAt: '2026-07-20T00:00:00.000Z',
    status: 'queued'
  };
  let firstRunnerCalls = 0;
  let secondRunnerCalls = 0;
  await durableRepository.enqueue(item);

  const firstWorker = createTranslationExecutionWorker(workerDependencies({
    durableTranslationExecutionQueueRepository: durableRepository,
    clock: () => '2026-07-20T00:00:00.000Z',
    leaseIdFactory: () => 'lease-1',
    translationExecutionRunner: { run() { firstRunnerCalls += 1; } }
  }));
  const secondWorker = createTranslationExecutionWorker(workerDependencies({
    durableTranslationExecutionQueueRepository: durableRepository,
    clock: () => '2026-07-20T00:01:00.000Z',
    leaseIdFactory: () => 'lease-2',
    translationExecutionRunner: { run() { secondRunnerCalls += 1; } }
  }));

  await firstWorker.processNext();
  await assert.rejects(secondWorker.processNext(), /must be queued before it can be claimed/);

  assert.equal(firstRunnerCalls, 1);
  assert.equal(secondRunnerCalls, 0);
  assert.deepEqual(await durableRepository.peek(), {
    ...item,
    status: 'processing',
    fenceToken: 1,
    attempt: 0,
    availableAt: null,
    lastFailure: null,
    leaseId: 'lease-1',
    claimedAt: '2026-07-20T00:00:00.000Z',
    leaseExpiresAt: '2026-07-20T00:05:00.000Z'
  });
});

test('durable worker rejects invalid lease configuration deterministically', () => {
  for (const leaseDurationMs of [0, -1, 1.5, '300000']) {
    assert.throws(
      () => createTranslationExecutionWorker(workerDependencies({
        durableTranslationExecutionQueueRepository: durableRepository(),
        leaseDurationMs
      })),
      /leaseDurationMs must be a positive integer/
    );
  }
});

test('durable worker rejects invalid clock and lease ID results before claiming or running', async () => {
  for (const options of [
    { clock: () => '2026-07-20T00:00:00Z' },
    { leaseIdFactory: () => '' }
  ]) {
    const calls = [];
    const worker = createTranslationExecutionWorker(workerDependencies({
      calls,
      durableTranslationExecutionQueueRepository: durableRepository({ calls }),
      ...options
    }));

    await assert.rejects(worker.processNext(), TypeError);
    assert.deepEqual(calls.map((call) => call[0]), ['findExecutionById', 'findRequestById']);
  }
});

test('non-durable worker does not require lease dependencies', async () => {
  const calls = [];
  const worker = createTranslationExecutionWorker(workerDependencies({
    calls,
    leaseDurationMs: 0,
    clock: null,
    leaseIdFactory: null
  }));

  await worker.processNext();

  assert.equal(calls.filter((call) => call[0] === 'runner.run').length, 1);
});

test('missing execution throws stable error without querying request or runner', async () => {
  const calls = [];
  const worker = createTranslationExecutionWorker(
    workerDependencies({
      calls,
      translationRepository: repository({ calls, execution: null })
    })
  );

  await assert.rejects(worker.processNext(), /TranslationExecution execution-1 was not found/);

  assert.deepEqual(calls, [['findExecutionById', 'execution-1']]);
});

test('missing request throws stable error without calling runner', async () => {
  const calls = [];
  const worker = createTranslationExecutionWorker(
    workerDependencies({
      calls,
      translationRepository: repository({ calls, request: null })
    })
  );

  await assert.rejects(worker.processNext(), /TranslationRequest request-1 was not found/);

  assert.deepEqual(calls.map((call) => call[0]), ['findExecutionById', 'findRequestById']);
  assert.equal(calls.some((call) => call[0] === 'runner.run'), false);
});

test('runner receives persisted lookup objects instead of queue payload references', async () => {
  const calls = [];
  const persistedExecution = translationExecution({ id: 'execution-persisted' });
  const persistedRequest = translationRequest({ id: 'request-persisted' });
  const queueExecution = { id: 'execution-from-queue' };
  const queueRequest = { id: 'request-from-queue' };
  const worker = createTranslationExecutionWorker(
    workerDependencies({
      calls,
      translationExecutionQueue: queue([
        {
          executionId: 'execution-persisted',
          requestId: 'request-persisted',
          execution: queueExecution,
          request: queueRequest,
          sourceText: 'queue payload should not be used'
        }
      ]),
      translationRepository: repository({
        calls,
        execution: persistedExecution,
        request: persistedRequest
      })
    })
  );

  await worker.processNext();

  const runnerInput = calls.find((call) => call[0] === 'runner.run')[1];
  assert.strictEqual(runnerInput.execution, persistedExecution);
  assert.strictEqual(runnerInput.request, persistedRequest);
  assert.notStrictEqual(runnerInput.execution, queueExecution);
  assert.notStrictEqual(runnerInput.request, queueRequest);
  assert.equal(Object.hasOwn(runnerInput, 'sourceText'), false);
});

test('runner error propagates unchanged', async () => {
  const runnerError = new Error('runner failed');
  const worker = createTranslationExecutionWorker(
    workerDependencies({
      translationExecutionRunner: {
        run() {
          throw runnerError;
        }
      }
    })
  );

  await assert.rejects(worker.processNext(), (actualError) => actualError === runnerError);
});

test('runner failure is acknowledged after failed state persistence and rethrows the original error', async () => {
  const calls = [];
  const runnerError = new Error('runner failed');
  let persistedExecution = translationExecution();
  const worker = createTranslationExecutionWorker(
    workerDependencies({
      calls,
      translationExecutionRunner: {
        run() {
          calls.push(['runner.run']);
          persistedExecution = executionWithStatus('failed');
          throw runnerError;
        }
      },
      translationRepository: repository({ calls, execution: () => persistedExecution }),
      leaseIdFactory: () => 'lease-1',
      durableTranslationExecutionQueueRepository: durableRepository({
        calls,
        acknowledgeClaim(executionId, claim) {
          calls.push(['durable.acknowledgeClaim', persistedExecution.status, executionId, claim]);
        }
      })
    })
  );

  await assert.rejects(worker.processNext(), (error) => error === runnerError);

  assert.deepEqual(calls.at(-1), ['durable.acknowledgeClaim', 'failed', 'execution-1', { leaseId: 'lease-1', fenceToken: 1 }]);
  assert.equal(calls.filter((call) => call[0] === 'runner.run').length, 1);
});

test('runner failure without persisted terminal state does not acknowledge', async () => {
  const calls = [];
  const runnerError = new Error('runner failed before terminal persistence');
  const worker = createTranslationExecutionWorker(
    workerDependencies({
      calls,
      translationExecutionRunner: {
        run() {
          calls.push(['runner.run']);
          throw runnerError;
        }
      },
      durableTranslationExecutionQueueRepository: durableRepository({ calls })
    })
  );

  await assert.rejects(worker.processNext(), (error) => error === runnerError);

  assert.equal(calls.some((call) => call[0] === 'durable.acknowledgeClaim'), false);
});

test('retryable provider failure requeues the owned durable item and resumes the running execution', async () => {
  const durableRepository = createFakeDurableTranslationExecutionQueueRepository();
  await durableRepository.enqueue({
    executionId: 'execution-1', requestId: 'request-1', enqueuedAt: '2026-07-20T00:00:00.000Z', status: 'queued'
  });
  let persistedExecution = translationExecution();
  const updates = [];
  const worker = createTranslationExecutionWorker(workerDependencies({
    durableTranslationExecutionQueueRepository: durableRepository,
    translationRepository: repository({
      execution: () => persistedExecution,
      updateTranslationExecution(next) {
        updates.push(next);
        persistedExecution = next;
        return next;
      }
    }),
    translationExecutionRunner: {
      run() {
        persistedExecution = persistedExecution.start();
        throw Object.assign(new Error('temporary provider failure'), { transient: true });
      }
    },
    translationExecutionRetryPolicy: {
      canRetry(attempt) { return attempt < 3; },
      getNextDelayMs() { return 1000; }
    },
    translationExecutionRetryErrorClassifier: {
      classify() { return { retryable: true, reason: 'transient_error' }; }
    },
    clock: () => '2026-07-20T00:00:00.000Z',
    leaseIdFactory: () => 'lease-1'
  }));

  assert.deepEqual(await worker.processNext(), { status: 'retried', executionId: 'execution-1' });
  assert.equal(persistedExecution.status, 'queued');
  assert.equal(updates.length, 1);
  assert.deepEqual(await durableRepository.peek(), {
    executionId: 'execution-1', requestId: 'request-1', enqueuedAt: '2026-07-20T00:00:00.000Z',
    status: 'queued', fenceToken: 1, attempt: 1, availableAt: '2026-07-20T00:00:01.000Z',
    lastFailure: { reason: 'transient_error', message: 'temporary provider failure' }
  });
});

test('non-retryable provider failure keeps terminal acknowledgement behavior', async () => {
  const durableRepository = createFakeDurableTranslationExecutionQueueRepository();
  await durableRepository.enqueue({
    executionId: 'execution-1', requestId: 'request-1', enqueuedAt: '2026-07-20T00:00:00.000Z', status: 'queued'
  });
  const providerError = new Error('invalid provider request');
  let persistedExecution = translationExecution();
  const worker = createTranslationExecutionWorker(workerDependencies({
    durableTranslationExecutionQueueRepository: durableRepository,
    translationRepository: repository({
      execution: () => persistedExecution,
      updateTranslationExecution(next) { persistedExecution = next; return next; }
    }),
    translationExecutionRunner: { run() { persistedExecution = persistedExecution.start(); throw providerError; } },
    translationExecutionRetryPolicy: { canRetry() { return true; }, getNextDelayMs() { return 1000; } },
    translationExecutionRetryErrorClassifier: { classify() { return { retryable: false, reason: 'gemini_client_error' }; } },
    clock: () => '2026-07-20T00:00:00.000Z', leaseIdFactory: () => 'lease-1'
  }));

  await assert.rejects(worker.processNext(), (error) => error === providerError);
  assert.equal(persistedExecution.status, 'failed');
  assert.equal(await durableRepository.size(), 0);
});

test('non-retryable provider failure transfers the owned durable item to the DLQ with terminal metadata', async () => {
  const deadLetterQueueRepository = createFakeDeadLetterQueueRepository();
  const durableRepository = createFakeDurableTranslationExecutionQueueRepository({ deadLetterQueueRepository });
  await durableRepository.enqueue({
    executionId: 'execution-1', requestId: 'request-1', enqueuedAt: '2026-07-20T00:00:00.000Z', status: 'queued',
    attempt: 2, availableAt: '2026-07-20T00:00:00.000Z', lastFailure: { reason: 'transient_error' }
  });
  const providerError = Object.assign(new Error('invalid provider request'), { code: 'INVALID_ARGUMENT' });
  let persistedExecution = translationExecution();
  const worker = createTranslationExecutionWorker(workerDependencies({
    durableTranslationExecutionQueueRepository: durableRepository,
    translationRepository: repository({
      execution: () => persistedExecution,
      updateTranslationExecution(next) { persistedExecution = next; return next; }
    }),
    translationExecutionRunner: { run() { persistedExecution = persistedExecution.start(); throw providerError; } },
    translationExecutionRetryPolicy: { canRetry() { return false; }, getNextDelayMs() { return 1000; } },
    translationExecutionRetryErrorClassifier: { classify() { return { retryable: false, reason: 'gemini_client_error' }; } },
    clock: () => '2026-07-20T00:00:02.000Z', leaseIdFactory: () => 'lease-1'
  }));

  await assert.rejects(worker.processNext(), (error) => error === providerError);
  assert.equal(await durableRepository.size(), 0);
  assert.deepEqual(await deadLetterQueueRepository.list(), [{
    executionId: 'execution-1', requestId: 'request-1', attempt: 3,
    availableAt: '2026-07-20T00:00:00.000Z', lastFailure: { reason: 'transient_error' },
    failedAt: '2026-07-20T00:00:02.000Z',
    failure: { reason: 'gemini_client_error', message: 'invalid provider request', code: 'INVALID_ARGUMENT' },
    providerMetadata: { providerKey: null },
    executionMetadata: { translationRequestId: 'request-1', startedAt: 1000, targetLanguageCode: 'fr' }
  }]);
});

test('DLQ write failure retains the terminal durable item without a second provider attempt', async () => {
  const deadLetterError = new Error('dlq unavailable');
  const durableRepository = createFakeDurableTranslationExecutionQueueRepository({
    deadLetterQueueRepository: { enqueue() { throw deadLetterError; }, list() {}, size() {}, clear() {} }
  });
  await durableRepository.enqueue({ executionId: 'execution-1', requestId: 'request-1', enqueuedAt: '2026-07-20T00:00:00.000Z', status: 'queued' });
  const providerError = new Error('invalid provider request');
  let persistedExecution = translationExecution();
  let providerCalls = 0;
  const worker = createTranslationExecutionWorker(workerDependencies({
    durableTranslationExecutionQueueRepository: durableRepository,
    translationRepository: repository({ execution: () => persistedExecution, updateTranslationExecution(next) { persistedExecution = next; return next; } }),
    translationExecutionRunner: { run() { providerCalls += 1; persistedExecution = persistedExecution.start(); throw providerError; } },
    translationExecutionRetryPolicy: { canRetry() { return false; }, getNextDelayMs() { return 1000; } },
    translationExecutionRetryErrorClassifier: { classify() { return { retryable: false, reason: 'gemini_client_error' }; } },
    clock: () => '2026-07-20T00:00:02.000Z', leaseIdFactory: () => 'lease-1'
  }));

  await assert.rejects(worker.processNext(), (error) => error === providerError);
  assert.equal(providerCalls, 1);
  assert.equal(persistedExecution.status, 'failed');
  assert.equal((await durableRepository.peek()).status, 'processing');
});

test('acknowledgement failure propagates unchanged without rerunning the runner', async () => {
  const calls = [];
  const acknowledgementError = new Error('acknowledgement failed');
  let persistedExecution = translationExecution();
  const worker = createTranslationExecutionWorker(
    workerDependencies({
      calls,
      translationExecutionRunner: {
        run() {
          calls.push(['runner.run']);
          persistedExecution = executionWithStatus('completed');
        }
      },
      translationRepository: repository({ calls, execution: () => persistedExecution }),
      durableTranslationExecutionQueueRepository: durableRepository({
        calls,
        acknowledgeClaim() {
          calls.push(['durable.acknowledgeClaim']);
          throw acknowledgementError;
        }
      })
    })
  );

  await assert.rejects(worker.processNext(), (error) => error === acknowledgementError);
  assert.equal(calls.filter((call) => call[0] === 'runner.run').length, 1);
  assert.equal(calls.filter((call) => call[0] === 'durable.acknowledgeClaim').length, 1);
});

test('runner failure keeps the provider error when lease-aware acknowledgement rejects', async () => {
  const providerError = new Error('provider failed');
  const ownershipError = new Error('lease ownership changed');
  let persistedExecution = translationExecution();
  let runnerCalls = 0;
  const worker = createTranslationExecutionWorker(workerDependencies({
    leaseIdFactory: () => 'lease-1',
    translationExecutionRunner: {
      run() {
        runnerCalls += 1;
        persistedExecution = executionWithStatus('failed');
        throw providerError;
      }
    },
    translationRepository: repository({ execution: () => persistedExecution }),
    durableTranslationExecutionQueueRepository: durableRepository({
      acknowledgeClaim() {
        throw ownershipError;
      }
    })
  }));

  await assert.rejects(worker.processNext(), (error) => error === providerError);
  assert.equal(runnerCalls, 1);
});

test('non-durable worker does not claim or acknowledge', async () => {
  const calls = [];
  const worker = createTranslationExecutionWorker(workerDependencies({ calls }));

  await worker.processNext();

  assert.equal(calls.some((call) => call[0] === 'durable.claim'), false);
  assert.equal(calls.some((call) => call[0] === 'durable.acknowledge'), false);
});

test('dequeue removes processed job from queue', async () => {
  const queue = createInMemoryTranslationExecutionQueue();
  queue.enqueue({ executionId: 'execution-1', requestId: 'request-1' });
  const worker = createTranslationExecutionWorker(workerDependencies({ translationExecutionQueue: queue }));

  await worker.processNext();

  assert.equal(queue.size(), 0);
  assert.equal(queue.dequeue(), null);
});

test('worker can delegate to existing execute runner method', async () => {
  const calls = [];
  const worker = createTranslationExecutionWorker(
    workerDependencies({
      calls,
      translationExecutionRunner: {
        execute(input) {
          calls.push(['runner.execute', input]);
        }
      }
    })
  );

  await worker.processNext();

  assert.equal(calls.filter((call) => call[0] === 'runner.execute').length, 1);
});

function workerDependencies(options = {}) {
  const calls = options.calls ?? [];
  return {
    translationExecutionQueue:
      options.translationExecutionQueue ?? queue([{ executionId: 'execution-1', requestId: 'request-1' }]),
    translationRepository: options.translationRepository ?? repository({ calls }),
    translationExecutionRunner:
      options.translationExecutionRunner ??
      {
        run(input) {
          calls.push(['runner.run', input]);
        }
      },
    ...(options.durableTranslationExecutionQueueRepository !== undefined
      ? { durableTranslationExecutionQueueRepository: options.durableTranslationExecutionQueueRepository }
      : {}),
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
    ...(options.leaseIdFactory !== undefined ? { leaseIdFactory: options.leaseIdFactory } : {}),
    ...(options.leaseDurationMs !== undefined ? { leaseDurationMs: options.leaseDurationMs } : {}),
    ...(options.leaseRenewalMs !== undefined ? { leaseRenewalMs: options.leaseRenewalMs } : {}),
    ...(options.leaseHeartbeatScheduler !== undefined ? { leaseHeartbeatScheduler: options.leaseHeartbeatScheduler } : {}),
    ...(options.translationExecutionRetryPolicy !== undefined ? { translationExecutionRetryPolicy: options.translationExecutionRetryPolicy } : {}),
    ...(options.translationExecutionRetryErrorClassifier !== undefined ? { translationExecutionRetryErrorClassifier: options.translationExecutionRetryErrorClassifier } : {}),
    ...(options.retryRandom !== undefined ? { retryRandom: options.retryRandom } : {})
  };
}

function queue(jobs = []) {
  const entries = [...jobs];

  return {
    dequeue() {
      return entries.shift();
    },
    enqueue(job) {
      entries.push(job);
    },
    isEmpty() {
      return entries.length === 0;
    },
    size() {
      return entries.length;
    }
  };
}

function durableRepository({ calls = [], claim, acknowledgeClaim, retryClaim, renewClaim, assertClaimActive } = {}) {
  return {
    enqueue() {
      throw new Error('worker should not enqueue durable repository');
    },
    dequeue() {
      throw new Error('worker should not dequeue durable repository');
    },
    peek() {
      throw new Error('worker should not peek durable repository');
    },
    list() {
      throw new Error('worker should not list durable repository');
    },
    listAvailable() {
      throw new Error('worker should not list available durable items');
    },
    nextAvailableAt() {
      throw new Error('worker should not inspect durable availability');
    },
    size() {
      throw new Error('worker should not read durable repository size');
    },
    clear() {
      throw new Error('worker should not clear durable repository');
    },
    updateStatus() {
      throw new Error('worker must not update durable queue status after atomic claim');
    },
    acknowledge() {
      throw new Error('worker must use lease-aware acknowledgement');
    },
    acknowledgeClaim:
      acknowledgeClaim ||
      function acknowledgeClaimDefault(executionId, claimInput) {
        calls.push(['durable.acknowledgeClaim', executionId, claimInput]);
      },
    contains() {
      throw new Error('worker should not query durable item existence');
    },
    claim: claim || function claimDefault(executionId, lease) {
      calls.push(['durable.claim', executionId, lease]);
      return { leaseId: lease.leaseId, fenceToken: 1 };
    },
    retryClaim: retryClaim || function retryClaimDefault() {
      throw new Error('worker should not retry durable items');
    },
    renewClaim: renewClaim || function renewClaimDefault() {
      throw new Error('worker should not renew durable items');
    },
    assertClaimActive: assertClaimActive || function assertClaimActiveDefault() {
      throw new Error('worker should not assert durable claim activity');
    },
    requeueExpiredProcessing() {
      throw new Error('worker should not requeue expired durable items');
    }
  };
}

function fakeScheduler() {
  const active = new Set();
  return {
    set(callback) {
      active.add(callback);
      return callback;
    },
    clear(callback) {
      active.delete(callback);
    },
    async runNext() {
      const callback = active.values().next().value;
      if (callback !== undefined) {
        active.delete(callback);
        await callback();
      }
    },
    activeCount() {
      return active.size;
    }
  };
}

async function flushMicrotasks() {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

function repository({ calls = [], execution = translationExecution(), request = translationRequest(), updateTranslationExecution } = {}) {
  return Object.fromEntries(
    TRANSLATION_REPOSITORY_METHODS.map((methodName) => [
      methodName,
      function repositoryMethod(identifier) {
        if (methodName === 'findExecutionById') {
          calls.push([methodName, identifier]);
          return typeof execution === 'function' ? execution(identifier) : execution;
        }

        if (methodName === 'findRequestById') {
          calls.push([methodName, identifier]);
          return request;
        }

        if (methodName === 'updateTranslationExecution' && updateTranslationExecution !== undefined) {
          return updateTranslationExecution(identifier);
        }

        throw new Error(`${methodName} should not be called by TranslationExecutionWorker.`);
      }
    ])
  );
}

function translationExecution(overrides = {}) {
  return new TranslationExecution({
    id: 'execution-1',
    translationRequestId: 'request-1',
    status: 'queued',
    startedAt: 1000,
    ...overrides
  });
}

function executionWithStatus(status) {
  return translationExecution({
    status,
    ...(status === 'completed' ? { completedAt: 1100 } : {}),
    ...(status === 'failed' ? { completedAt: 1100, failureInfo: { code: 'failed' } } : {})
  });
}

function translationRequest(overrides = {}) {
  return new TranslationRequest({
    id: 'request-1',
    sessionId: 'session-1',
    sourceTranscriptRevisionId: 'revision-1',
    targetLanguageCode: 'fr',
    sourceTranscriptSnapshot: {
      text: 'hello'
    },
    createdAt: 900,
    ...overrides
  });
}
